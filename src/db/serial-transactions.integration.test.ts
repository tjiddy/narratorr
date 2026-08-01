import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from './index.js';
import { books } from './schema.js';
import { NestedTransactionError } from './serial-transactions.js';
import { generatePublicId } from '../server/utils/public-id.js';

/**
 * Real migrated libSQL, never a double: the constraint under test is the DRIVER's — one
 * transaction per connection — and only a real connection can exhibit it. Before #1959 F12 the
 * first case here produced one fulfilled promise and three `SQLITE_BUSY` rejections.
 *
 * Every case calls `db.transaction(...)` the plain way, exactly as the twenty-two existing
 * production call sites do. That is the point of the finding: the guarantee has to hold for
 * callers that know nothing about serialization, not only for the two that once opted into a
 * helper.
 */
describe('per-connection transaction serialization (#1959 F12)', () => {
  let dir: string;
  let dbFile: string;
  let db: Db;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-tx-'));
    dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterAll(() => {
    // Tolerant on Windows only: the libSQL handle keeps the dir undeletable
    // (EPERM) even after close — see src/server/__tests__/e2e-helpers.ts:38 and
    // the `windows-hostile-test-primitives` learning. Inlined rather than using
    // src/server/__tests__/windows-fs.ts because src/db does not import server.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  });

  beforeEach(async () => {
    await db.delete(books);
  });

  function insert(title: string) {
    return { publicId: generatePublicId('bk'), title, status: 'imported' as const };
  }

  it('lets four concurrent unrelated transactions all commit instead of losing three to SQLITE_BUSY', async () => {
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map((n) =>
        db.transaction(async (tx) => {
          await tx.select().from(books).limit(1);
          // Yield inside the transaction: without serialization this is where the next
          // BEGIN lands on the same connection and the driver refuses it.
          await new Promise((resolve) => setTimeout(resolve, 5));
          await tx.insert(books).values(insert(`concurrent ${n}`));
          return n;
        }),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(await db.select().from(books)).toHaveLength(4);
  });

  it('never interleaves two transaction bodies', async () => {
    const events: string[] = [];

    await Promise.all(
      [1, 2, 3].map((n) =>
        db.transaction(async (tx) => {
          events.push(`begin:${n}`);
          await tx.insert(books).values(insert(`ordered ${n}`));
          await new Promise((resolve) => setTimeout(resolve, 2));
          events.push(`commit:${n}`);
        }),
      ),
    );

    // Strict begin/commit pairing — any overlap shows up as two consecutive `begin:` entries.
    expect(events).toEqual(['begin:1', 'commit:1', 'begin:2', 'commit:2', 'begin:3', 'commit:3']);
  });

  it('covers a caller that never heard of the lane, racing one that queues behind it', async () => {
    // The reconciler's guarded-write shape (read, decide, write) run concurrently with a bare
    // insert transaction — two independent call sites, neither aware of the other.
    const [a, b] = await Promise.all([
      db.transaction(async (tx) => {
        const rows = await tx.select().from(books);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await tx.insert(books).values(insert('guarded'));
        return rows.length;
      }),
      db.transaction(async (tx) => {
        await tx.insert(books).values(insert('bare'));
        return 'bare';
      }),
    ]);

    expect(a).toBe(0);
    expect(b).toBe('bare');
    expect((await db.select().from(books)).map((row) => row.title).sort()).toEqual(['bare', 'guarded']);
  });

  it('releases the connection after a rolled-back transaction', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(books).values(insert('doomed'));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    // A tail advanced with a bare `.then(fn)` would have inherited the rejection and refused
    // every later transaction on this connection, permanently.
    await expect(db.transaction(async (tx) => {
      await tx.insert(books).values(insert('after rollback'));
      return 'ok';
    })).resolves.toBe('ok');
    expect((await db.select().from(books)).map((row) => row.title)).toEqual(['after rollback']);
  });

  it('rejects a nested transaction on the same connection instead of deadlocking', async () => {
    // Re-entering `db.transaction` from inside its own callback would queue behind a tail its
    // own caller is holding — a silent hang. The guard turns that into a named error.
    await expect(
      db.transaction(async () => {
        await db.transaction(async () => 'inner');
        return 'outer';
      }),
    ).rejects.toBeInstanceOf(NestedTransactionError);

    // …and the connection is still usable afterwards.
    await expect(db.transaction(async () => 'fine')).resolves.toBe('fine');
  });

  it('lets a continuation born inside the callback open a transaction AFTER the outer settles (#2008)', async () => {
    // AsyncLocalStorage context is captured at async-resource creation and kept forever, so
    // this `.then` continuation holds the transaction's store long after the commit. The
    // deadlock the guard prevents is only possible while the outer is PENDING — a descendant
    // invoked post-settle must queue like any other caller, not reject. Before #2008 the
    // marker was immortal set-membership and this rejected with NestedTransactionError.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let descendant!: Promise<string>;

    await db.transaction(async (tx) => {
      await tx.insert(books).values(insert('outer write'));
      // Created INSIDE the transaction's context; invoked only when the gate opens.
      descendant = gate.then(() =>
        db.transaction(async (tx2) => {
          await tx2.insert(books).values(insert('descendant write'));
          return 'queued fine';
        }),
      );
    });

    releaseGate(); // strictly after the outer settled
    await expect(descendant).resolves.toBe('queued fine');
    expect((await db.select().from(books)).map((row) => row.title))
      .toEqual(['outer write', 'descendant write']);
  });

  it('still rejects a created-inside continuation that calls while the outer is PENDING (#2008)', async () => {
    // The twin that pins the flip did not over-relax: same async-resource shape, but the
    // outer awaits it, so the outer is still pending when the inner call happens — that is
    // the real deadlock case and it must keep rejecting.
    await expect(
      db.transaction(async () => {
        return Promise.resolve().then(() => db.transaction(async () => 'inner'));
      }),
    ).rejects.toBeInstanceOf(NestedTransactionError);

    await expect(db.transaction(async () => 'fine')).resolves.toBe('fine');
  });

  it('does not make one connection wait on another', async () => {
    const otherFile = join(dir, 'other.db');
    await runMigrations(otherFile);
    const other = createDb(otherFile);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const blocking = db.transaction(async () => { await held; return 'first'; });
    // Runs to completion while the first connection's transaction is still open.
    await expect(other.transaction(async (tx) => {
      await tx.insert(books).values(insert('other connection'));
      return 'second';
    })).resolves.toBe('second');

    release();
    await expect(blocking).resolves.toBe('first');
  });
});
