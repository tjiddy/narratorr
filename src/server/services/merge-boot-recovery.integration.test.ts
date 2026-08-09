import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookEvents } from '@db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import type { EventSource, EventType } from '@shared/schemas/event-history.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import {
  findInterruptedMergeCandidates,
  settleInterruptedMerges,
  type SettleInterruptedMergesDeps,
} from './merge-boot-recovery.js';

/** Real SQLite is required: one-second timestamps tie, so MAX(id) must identify the latest event. */
describe('#2099 merge boot recovery — detection against real SQLite', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'merge-boot-recovery-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libSQL may retain Windows handles; cleanup is best-effort.
    }
  });

  async function seedBook(title: string, path?: string): Promise<number> {
    const [row] = await db.insert(books).values({
      publicId: generatePublicId('bk'),
      title,
      status: 'imported',
      ...(path !== undefined && { path }),
    }).returning();
    return row!.id;
  }

  /** Allow exact same-second events to exercise id tie-breaking. */
  async function seedEvent(opts: {
    bookId: number | null;
    bookTitle: string;
    eventType: EventType;
    source?: EventSource;
    createdAt: Date;
  }): Promise<void> {
    await db.insert(bookEvents).values({
      bookId: opts.bookId,
      bookTitle: opts.bookTitle,
      eventType: opts.eventType,
      source: opts.source ?? 'auto',
      createdAt: opts.createdAt,
    });
  }

  it('returns exactly the books whose latest merge-family row (by id) is merge_started', async () => {
    const sameSecond = new Date('2026-08-03T19:53:05Z');

    // Dangling live-crash case.
    const dangling = await seedBook('Stormrage');
    await seedEvent({ bookId: dangling, bookTitle: 'Stormrage', eventType: 'merge_started', source: 'auto', createdAt: sameSecond });

    // Same-second merge_started + merged is settled, not a candidate.
    const settled = await seedBook('Babylon’s Ashes');
    await seedEvent({ bookId: settled, bookTitle: 'Babylon’s Ashes', eventType: 'merge_started', createdAt: sameSecond });
    await seedEvent({ bookId: settled, bookTitle: 'Babylon’s Ashes', eventType: 'merged', createdAt: sameSecond });

    // The latest of two attempts is dangling.
    const second = await seedBook('The Way of Kings');
    await seedEvent({ bookId: second, bookTitle: 'The Way of Kings', eventType: 'merge_started', source: 'manual', createdAt: sameSecond });
    await seedEvent({ bookId: second, bookTitle: 'The Way of Kings', eventType: 'merge_failed', source: 'manual', createdAt: sameSecond });
    await seedEvent({ bookId: second, bookTitle: 'The Way of Kings', eventType: 'merge_started', source: 'manual', createdAt: sameSecond });

    // A deleted book has a null FK and cannot settle.
    await seedEvent({ bookId: null, bookTitle: 'Deleted Book', eventType: 'merge_started', createdAt: sameSecond });

    // Non-merge history is irrelevant.
    const untouched = await seedBook('Dune');
    await seedEvent({ bookId: untouched, bookTitle: 'Dune', eventType: 'imported', createdAt: sameSecond });

    const candidates = await findInterruptedMergeCandidates(db);

    expect(candidates.map((c) => c.bookId).sort((a, b) => a - b)).toEqual([dangling, second].sort((a, b) => a - b));
    expect(candidates.find((c) => c.bookId === dangling)).toMatchObject({ source: 'auto', bookTitle: 'Stormrage' });
    const secondCandidate = candidates.find((c) => c.bookId === second)!;
    expect(secondCandidate.source).toBe('manual');
    const secondRows = await db.select().from(bookEvents);
    const latestStartId = Math.max(...secondRows.filter((r) => r.bookId === second).map((r) => r.id));
    expect(secondCandidate.eventId).toBe(latestStartId);
  });

  it('a merged row written in the same second as its start is never re-detected', async () => {
    const sameSecond = new Date('2026-08-03T19:53:05Z');
    const bookId = await seedBook('Stormrage');
    await seedEvent({ bookId, bookTitle: 'Stormrage', eventType: 'merge_started', createdAt: sameSecond });
    await seedEvent({ bookId, bookTitle: 'Stormrage', eventType: 'merged', createdAt: sameSecond });

    const rows = await db.select().from(bookEvents);
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(1); // Prove the tie is real.
    expect(await findInterruptedMergeCandidates(db)).toEqual([]);
  });

  it('settles a real dangling merge end to end and finds nothing on the second pass', async () => {
    const libraryRoot = mkdtempSync(join(tmpdir(), 'merge-boot-recovery-lib-'));
    try {
      const bookPath = join(libraryRoot, 'Author', 'Stormrage');
      const stagingDir = join(libraryRoot, 'Author', '.Stormrage.merge-tmp');
      await mkdir(bookPath, { recursive: true });
      await writeFile(join(bookPath, '01.mp3'), 'a');
      await writeFile(join(bookPath, '02.mp3'), 'b');
      await mkdir(stagingDir, { recursive: true });
      await writeFile(join(stagingDir, 'out.m4b'), 'x');

      const bookId = await seedBook('Stormrage', bookPath);
      await seedEvent({ bookId, bookTitle: 'Stormrage', eventType: 'merge_started', source: 'auto', createdAt: new Date('2026-08-03T19:53:05Z') });

      // Persist terminal events so the second pass exercises real idempotence.
      const create = vi.fn(async (input: { bookId: number; bookTitle: string; eventType: EventType; source: EventSource; reason?: unknown }) => {
        await db.insert(bookEvents).values({
          bookId: input.bookId,
          bookTitle: input.bookTitle,
          eventType: input.eventType,
          source: input.source,
          reason: input.reason as Record<string, unknown>,
        });
      });
      const deps: SettleInterruptedMergesDeps = {
        db,
        log: inject<FastifyBaseLogger>(log),
        eventHistory: { create } as never,
        bookService: { getById: vi.fn(async () => (await db.select().from(books))[0]) } as never,
        settingsService: { get: vi.fn(async () => ({ path: libraryRoot })) } as never,
      };

      const first = await settleInterruptedMerges(deps);

      expect(first.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
      expect(first.requeue).toEqual([bookId]);
      await expect(stat(stagingDir)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(bookPath)).sort()).toEqual(['01.mp3', '02.mp3']);
      const settlement = (await db.select().from(bookEvents)).find((r) => r.eventType === 'merge_failed')!;
      expect(settlement.source).toBe('auto');
      expect(settlement.reason).toEqual({ error: 'Interrupted by server restart', type: 'ProcessRestart' });

      create.mockClear();
      const second = await settleInterruptedMerges(deps);

      expect(second.counters).toEqual({ candidates: 0, cleaned: 0, settled: 0, retryable: 0, failed: 0 });
      expect(create).not.toHaveBeenCalled();
    } finally {
      rmSync(libraryRoot, { recursive: true, force: true });
    }
  });

  it('an ancient dangling merge_started with no staging dir left settles cleanly on the first boot', async () => {
    const libraryRoot = mkdtempSync(join(tmpdir(), 'merge-boot-recovery-old-'));
    try {
      const bookPath = join(libraryRoot, 'Author', 'Stormrage');
      await mkdir(bookPath, { recursive: true });
      const bookId = await seedBook('Stormrage', bookPath);
      await seedEvent({ bookId, bookTitle: 'Stormrage', eventType: 'merge_started', source: 'auto', createdAt: new Date('2024-01-01T00:00:00Z') });

      const create = vi.fn().mockResolvedValue(undefined);
      const plan = await settleInterruptedMerges({
        db,
        log: inject<FastifyBaseLogger>(log),
        eventHistory: { create } as never,
        bookService: { getById: vi.fn(async () => (await db.select().from(books))[0]) } as never,
        settingsService: { get: vi.fn(async () => ({ path: libraryRoot })) } as never,
      });

      expect(plan.counters).toEqual({ candidates: 1, cleaned: 0, settled: 1, retryable: 0, failed: 0 });
      expect(plan.requeue).toEqual([]);
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(libraryRoot, { recursive: true, force: true });
    }
  });
});
