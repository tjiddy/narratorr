import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from './index.js';
import { books } from './schema.js';
import { NestedTransactionError } from './serial-transactions.js';
import { generatePublicId } from '../server/utils/public-id.js';

// Real libSQL is required because one-active-transaction is a driver constraint.
// Use plain db.transaction calls so coverage does not depend on caller opt-in.
describe('per-connection transaction serialization (#1959 F12)', () => {
  let dir: string;
  let dbFile: string;
  let db: Db;
  /** Both this suite's connections, closed before removal — the second one is opened mid-test below. */
  const opened: Db[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'serial-tx-'));
    dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    opened.push(db);
  });

  afterAll(() => {
    // libSQL retains the directory handle on Windows until every client closes.
    for (const instance of opened) instance.$client.close();
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
          // Yield so, without serialization, the next BEGIN lands on this connection.
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

    expect(events).toEqual(['begin:1', 'commit:1', 'begin:2', 'commit:2', 'begin:3', 'commit:3']);
  });

  it('covers a caller that never heard of the lane, racing one that queues behind it', async () => {
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

    // A bare .then(open) would let this rejection poison every later transaction.
    await expect(db.transaction(async (tx) => {
      await tx.insert(books).values(insert('after rollback'));
      return 'ok';
    })).resolves.toBe('ok');
    expect((await db.select().from(books)).map((row) => row.title)).toEqual(['after rollback']);
  });

  it('rejects a nested transaction on the same connection instead of deadlocking', async () => {
    // Re-entry would wait forever on the tail held by its own outer transaction.
    await expect(
      db.transaction(async () => {
        await db.transaction(async () => 'inner');
        return 'outer';
      }),
    ).rejects.toBeInstanceOf(NestedTransactionError);

    await expect(db.transaction(async () => 'fine')).resolves.toBe('fine');
  });

  it('lets a continuation born inside the callback open a transaction AFTER the outer settles (#2008)', async () => {
    // ALS stores survive with async resources; inherited membership must expire when the
    // outer settles or this descendant would be falsely treated as nested.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    let descendant!: Promise<string>;

    await db.transaction(async (tx) => {
      await tx.insert(books).values(insert('outer write'));
      // Created inside the transaction context but invoked after the gate opens.
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
    // The same inherited context remains nested while the outer is pending.
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
    opened.push(other);

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const blocking = db.transaction(async () => { await held; return 'first'; });
    await expect(other.transaction(async (tx) => {
      await tx.insert(books).values(insert('other connection'));
      return 'second';
    })).resolves.toBe('second');

    release();
    await expect(blocking).resolves.toBe('first');
  });
});
