import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sql } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { sanitizedEnv } from '@core/utils/sanitized-env.js';
import { generatePublicId } from '../utils/public-id.js';
import { loadReplayCandidates } from './series-title-match-blast-check.js';

// Replay pools must match production's ascending-ID order; a real covering-index scan makes a missing orderBy observable.
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

  // The full projection triggers the covering-index scan; an id-only probe stays in rowid order and proves nothing.
  async function idsWithoutOrderBy(): Promise<number[]> {
    const rows = await db.run(sql`SELECT id, title, series_position, series_name FROM books`);
    return rows.rows.map((r) => Number(r.id));
  }

  it('returns library candidates in ascending book id under a competing covering index', async () => {
    // IDs ascend while series-name collation orders this fixture differently.
    const zeta = await seed('Zeta One', 'Zeta Series');
    const alphaFirst = await seed('Alpha One', 'Alpha Series');
    const tombstoned = await seed('Tombstoned Book', null);
    const alphaSecond = await seed('Alpha Two', 'Alpha Series');
    expect([zeta, alphaFirst, tombstoned, alphaSecond]).toEqual([1, 2, 3, 4]);

    await db.run(sql`CREATE INDEX idx_books_replay_order_2108 ON books (series_name, title, series_position)`);

    // Prove the index reorders this fixture; otherwise the ORDER BY assertion is vacuous.
    expect(await idsWithoutOrderBy()).toEqual([tombstoned, alphaFirst, alphaSecond, zeta]);

    const candidates = await loadReplayCandidates(db);

    // Match production: ascending IDs and no null-series tombstones.
    expect(candidates.map((c) => c.id)).toEqual([zeta, alphaFirst, alphaSecond]);
  });

  it('keeps every per-series pool in production order once filtered', async () => {
    // main filters this list into pools, so titles collate opposite their IDs to expose missing order after filtering.
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

// Both entry-guard arms need isolated children: imports are cached, and an ambient default DB can hide an unguarded main.
// Controlling argv and DATABASE_PATH makes the cwd-relative fallback unreachable.
describe('series-title-match-blast-check — CLI entry guard (#2108)', () => {
  // Resolve the CLI module directly because node_modules/.bin is a .CMD shim on Windows.
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const script = fileURLToPath(new URL('./series-title-match-blast-check.ts', import.meta.url));
  const SENTINEL = 'IMPORT-COMPLETED';
  // A fixed canary prevents the allowlist test passing merely because the host exports no forbidden key.
  const FORBIDDEN_KEY = 'NARRATORR_SECRET_KEY';
  const FORBIDDEN_VALUE = 'canary-value-never-a-real-key';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  interface ChildRun { status: number | null; stdout: string; stderr: string }

  // Keep repo cwd for tsconfig aliases, but force database selection through the sanitized environment.
  function runChild(entry: string, args: string[], dbPath: string): ChildRun {
    try {
      const stdout = execFileSync(process.execPath, [tsxCli, entry, ...args], {
        encoding: 'utf8',
        env: sanitizedEnv({ DATABASE_PATH: dbPath }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error: unknown) {
      const failure = error as { status?: number | null; stdout?: string; stderr?: string };
      return { status: failure.status ?? null, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
    }
  }

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

      // Outside the repo, .mts preserves ESM; .ts becomes CJS and a load failure could pass vacuously.
      const probe = join(dir, 'probe.mts');
      // JSON.stringify keeps generated imports valid when checkout paths contain apostrophes.
      writeFileSync(probe, `import ${JSON.stringify(pathToFileURL(script).href)};\n`
        + `process.stdout.write(JSON.stringify({ sentinel: ${JSON.stringify(SENTINEL)}, envKeys: Object.keys(process.env).sort() }));\n`);

      vi.stubEnv(FORBIDDEN_KEY, FORBIDDEN_VALUE);
      expect(process.env[FORBIDDEN_KEY]).toBe(FORBIDDEN_VALUE);

      const child = runChild(probe, [], missing);

      expect(child.stdout).toContain(SENTINEL);
      expect(`${child.stdout}${child.stderr}`).not.toContain('No database at');
      expect(child.status).toBe(0);

      const report = JSON.parse(child.stdout) as { envKeys: string[] };

      expect(report.envKeys).not.toContain(FORBIDDEN_KEY);
      // Windows injects infrastructure keys regardless of env; subtract an observed empty-env floor after checking it.
      const osInjectedFloor = new Set(JSON.parse(execFileSync(process.execPath,
        ['-p', 'JSON.stringify(Object.keys(process.env).sort())'],
        { encoding: 'utf8', env: {}, stdio: ['ignore', 'pipe', 'pipe'] }) ) as string[]);
      expect(osInjectedFloor).not.toContain(FORBIDDEN_KEY);
      // Derive sanctioned keys from sanitizedEnv so the test cannot drift from its allowlist.
      const sanctioned = new Set(Object.keys(sanitizedEnv({ DATABASE_PATH: missing })));
      expect(report.envKeys.filter((key) => !sanctioned.has(key) && !osInjectedFloor.has(key))).toEqual([]);
    });
  }, 60_000);

  it('still enters main when executed directly', () => {
    withTempDir((dir) => {
      // Missing-DB refusal is main's first observable, so execution needs no fixture.
      const missing = join(dir, 'absent.db');
      expect(existsSync(missing)).toBe(false);

      const child = runChild(script, [missing], missing);

      expect(child.stderr).toContain(`No database at ${missing}`);
      expect(child.status).toBe(1);
    });
  }, 60_000);
});
