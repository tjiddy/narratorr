import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { loadReplayCandidates } from './series-title-match-blast-check.js';

/**
 * #2108 AC12 — the blast check's whole premise is that each replayed pool
 * presents candidates in the SAME sequence production's
 * `loadLibraryBooksForSeriesNames` would. Both sides now pin `asc(books.id)`,
 * but only production's half had an executable signal (the forced-index fixture
 * in `series-card.integration.test.ts`); deleting the script's `.orderBy` left
 * every suite green, and a replay whose pools differ from production's reports
 * planner-dependent deltas production never sees. This is that missing half.
 *
 * Runs against a real migrated libSQL database, like the service integration
 * suite — the property under test is what SQLite actually returns, so a chain
 * mock could not observe it at all.
 */
describe('series-title-match-blast-check — replay candidate order (#2108)', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'blast-check-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep the file handle on Windows
    }
  });

  async function seed(title: string, seriesName: string | null): Promise<number> {
    const [book] = await db.insert(books).values({
      publicId: generatePublicId('bk'),
      title,
      seriesName,
      seriesPosition: null,
    }).returning();
    return book!.id;
  }

  /**
   * The projection is load-bearing and NOT interchangeable with a narrower one.
   * The replay reads all books unconstrained, so — unlike production's
   * `WHERE series_name IN (…)` — a bare index on `books(series_name)` does NOT
   * reorder it: SQLite keeps `SCAN books` and rowid order falls out, which would
   * make every assertion below pass with the `.orderBy` deleted. Only a COVERING
   * index over the whole projection flips it to
   * `SCAN books USING COVERING INDEX`, and only then does the ORDER BY decide.
   * (Measured: `SELECT id FROM books` alone stays in rowid order even with this
   * index — SQLite reads the table for a rowid-only projection. The probe below
   * must mirror the loader's four columns or it silently proves nothing.)
   */
  async function idsWithoutOrderBy(): Promise<number[]> {
    const rows = await db.run(sql`SELECT id, title, series_position, series_name FROM books`);
    return rows.rows.map((r) => Number(r.id));
  }

  it('returns library candidates in ascending book id under a competing covering index', async () => {
    // ids ASCEND while series_name collation DESCENDS, so the two orders disagree.
    const zeta = await seed('Zeta One', 'Zeta Series');
    const alphaFirst = await seed('Alpha One', 'Alpha Series');
    const tombstoned = await seed('Tombstoned Book', null);
    const alphaSecond = await seed('Alpha Two', 'Alpha Series');
    expect([zeta, alphaFirst, tombstoned, alphaSecond]).toEqual([1, 2, 3, 4]);

    await db.run(sql`CREATE INDEX idx_books_replay_order_2108 ON books (series_name, title, series_position)`);

    // Precondition — without an ORDER BY the planner really does hand these back
    // reordered (NULL series_name first, then the two Alphas, then Zeta). Without
    // this the assertion below could not distinguish a pinned order from a lucky
    // one, which is the exact shape of a vacuous ordering test.
    expect(await idsWithoutOrderBy()).toEqual([tombstoned, alphaFirst, alphaSecond, zeta]);

    const candidates = await loadReplayCandidates(db);

    // Ascending by id, and the `series_name IS NULL` tombstone is dropped —
    // production's `IN (…)` can never pool one, so the replay must not either.
    expect(candidates.map((c) => c.id)).toEqual([zeta, alphaFirst, alphaSecond]);
  });

  it('keeps every per-series pool in production order once filtered', async () => {
    // `main()` builds each replayed pool as a `.filter()` of this list, so pool
    // order is exactly the loader's order restricted to one series name — which
    // must equal the ascending-id subset production's
    // `WHERE series_name IN (…) ORDER BY books.id` returns for the same name.
    //
    // The two same-series titles collate in the OPPOSITE order to their ids, so
    // the index reorders WITHIN the pool and not merely across series. Without
    // that the filtered pool would come out ascending either way and this case
    // would survive the mutation test 1 catches — a green companion proving
    // nothing.
    const zeta = await seed('Zeta One', 'Zeta Series');
    const alphaLateTitle = await seed('Zulu Alpha Book', 'Alpha Series');
    const alphaEarlyTitle = await seed('Alpha Alpha Book', 'Alpha Series');

    await db.run(sql`CREATE INDEX idx_books_replay_order_2108 ON books (series_name, title, series_position)`);
    expect(await idsWithoutOrderBy()).toEqual([alphaEarlyTitle, alphaLateTitle, zeta]);

    const candidates = await loadReplayCandidates(db);
    const alphaPool = candidates.filter((c) => c.seriesName === 'Alpha Series');

    expect(alphaPool.map((c) => c.id)).toEqual([alphaLateTitle, alphaEarlyTitle]);
    expect(candidates.filter((c) => c.seriesName === 'Zeta Series').map((c) => c.id)).toEqual([zeta]);
  });
});

/**
 * #2108 — the CLI entry guard has TWO arms, and each needs its OWN isolated
 * child process. Neither is observable from inside the vitest worker:
 *
 *  - The TRUE arm can't be, because this module is already imported, so nothing
 *    a test does to `process.argv` re-evaluates the guard.
 *  - The FALSE arm can't be either, and that is subtler. Asserting the worker's
 *    ambient `process.exitCode` looks like an observation but is one only when
 *    the host happens to have no database on `main()`'s resolution chain,
 *    `process.argv[2] ?? process.env.DATABASE_PATH ?? './config/narratorr.db'`.
 *    MEASURED: with a database at that documented default path — which every
 *    developer who has run the app locally has — deleting the guard makes the
 *    import run the entire replay, return normally, and leave the exit code at
 *    0, so the whole suite stays green while the arm is broken.
 *
 * Both cases therefore spawn a child with every input on that chain CONTROLLED:
 * no extra argv, `DATABASE_PATH` pointed at a path inside a directory created
 * moments earlier, and — because `??` short-circuits on `DATABASE_PATH` — the
 * `./config/narratorr.db` default made unreachable rather than merely assumed
 * absent.
 */
describe('series-title-match-blast-check — CLI entry guard (#2108)', () => {
  // Resolved through Node's resolver rather than `node_modules/.bin`, which is a
  // `.CMD` shim on Windows; `process.execPath` is the node already running us.
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const script = fileURLToPath(new URL('./series-title-match-blast-check.ts', import.meta.url));
  /** Positive proof the child actually got to the end of its entry module. */
  const SENTINEL = 'IMPORT-COMPLETED';

  interface ChildRun { status: number | null; stdout: string; stderr: string }

  /**
   * Run `node <tsx> <entry> [args]` with the database path forced to `dbPath`.
   *
   * `cwd` stays the repo root so tsx resolves the `@db/*` tsconfig aliases the
   * script imports; the DB path is controlled through the environment instead,
   * which is both sufficient and stronger — setting `DATABASE_PATH` removes the
   * cwd-relative default from the chain entirely.
   */
  function runChild(entry: string, args: string[], dbPath: string): ChildRun {
    try {
      const stdout = execFileSync(process.execPath, [tsxCli, entry, ...args], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_PATH: dbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error: unknown) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return { status: failure.status ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

  /** A directory that did not exist a moment ago, so nothing in it can be stale or contended. */
  function withTempDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'blast-check-cli-'));
    try {
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('does not run the replay when the module is only imported', () => {
    withTempDir((dir) => {
      const missing = join(dir, 'absent.db');
      expect(existsSync(missing)).toBe(false);

      // `.mts`, not `.ts`: outside the repo no `"type": "module"` is in scope, so
      // tsx compiles the imported module as CJS and its top-level `await main()`
      // fails to transform — a load error that would satisfy "no replay ran"
      // vacuously. The sentinel below is what catches that.
      const probe = join(dir, 'probe.mts');
      writeFileSync(probe, `import '${pathToFileURL(script).href}';\nprocess.stdout.write('${SENTINEL}');\n`);

      const child = runChild(probe, [], missing);

      expect(child.stdout).toContain(SENTINEL);
      // Had `main()` run, the controlled-missing path guarantees this refusal.
      expect(`${child.stdout}${child.stderr}`).not.toContain('No database at');
      expect(child.status).toBe(0);
    });
  }, 60_000);

  it('still enters main when executed directly', () => {
    withTempDir((dir) => {
      // The missing-DB refusal is `main()`'s first observable, and it needs no
      // library fixture: the script deliberately refuses a path it would
      // otherwise create, so "did main run" is answerable without a database.
      const missing = join(dir, 'absent.db');
      expect(existsSync(missing)).toBe(false);

      const child = runChild(script, [missing], missing);

      // Both halves matter: a guard that never fires exits 0 with no output.
      expect(child.stderr).toContain(`No database at ${missing}`);
      expect(child.status).toBe(1);
    });
  }, 60_000);
});
