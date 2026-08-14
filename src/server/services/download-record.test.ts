import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { StagedHandoff } from '@core/download-clients/types.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { insertDownloadRecordOrCompensate, type InsertDownloadRecordCtx } from './download-record.js';

/**
 * #2341: the staged handoff makes the DB row the commit point, so every ordering and every
 * secondary failure below is a contract, not an implementation detail. Ordering is asserted by
 * gating the insert terminus rather than by call counts, which are order-blind.
 */

const dialect = new SQLiteSyncDialect();
function toSQL(expr: unknown): { sql: string; params: unknown[] } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((expr as any).getSQL());
}

const MAGNET = 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';
const ROW_ID = 7;

const params = { title: 'The Way of Kings', bookId: 1, indexerId: 2, guid: 'guid-1' };

/** Flush the microtask queue so a pending continuation would have run if it were going to. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

function fakeStaged(over?: Partial<StagedHandoff>): { commit: Mock; abort: Mock } & StagedHandoff {
  return {
    commit: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as { commit: Mock; abort: Mock } & StagedHandoff;
}

describe('insertDownloadRecordOrCompensate', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let removeDownload: Mock;
  let getAdapter: Mock;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    removeDownload = vi.fn().mockResolvedValue(undefined);
    getAdapter = vi.fn().mockResolvedValue({ removeDownload });
  });

  function ctx(over?: Partial<InsertDownloadRecordCtx>): InsertDownloadRecordCtx {
    return {
      effectiveDownloadUrl: MAGNET,
      protocol: 'torrent',
      infoHash: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
      clientId: 1,
      clientType: 'blackhole',
      externalId: null,
      staged: null,
      ...over,
    };
  }

  const run = (over?: Partial<InsertDownloadRecordCtx>) =>
    insertDownloadRecordOrCompensate(inject<Db>(db), inject<FastifyBaseLogger>(log), params, ctx(over), getAdapter);

  /** Hold the insert's `.returning()` terminus so issuance and persistence can be told apart. */
  function gateInsert(): { release: () => void; values: Mock } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const returning = vi.fn().mockImplementation(() => gate.then(() => [{ id: ROW_ID }]));
    const values = vi.fn().mockReturnValue({ returning });
    db.insert.mockReturnValue({ values } as never);
    return { release, values };
  }

  const insertResolves = () => db.insert.mockReturnValue(mockDbChain([{ id: ROW_ID }]));
  const insertRejects = (error: Error) => db.insert.mockReturnValue(mockDbChain([], { error }));

  type WarnCall = [Record<string, unknown>, string];
  const warnCalls = (): WarnCall[] => (log.warn as Mock).mock.calls as WarnCall[];
  const warnsMatching = (fragment: string): WarnCall[] =>
    warnCalls().filter(([, message]) => String(message).includes(fragment));

  describe('staged handoff — the publish follows the durable row', () => {
    it('commits the staged artifact only after the insert has persisted', async () => {
      const { release } = gateInsert();
      const staged = fakeStaged();

      const running = run({ staged });
      await settle();
      expect(staged.commit).not.toHaveBeenCalled();

      release();
      await expect(running).resolves.toEqual([{ id: ROW_ID }]);
      expect(staged.commit).toHaveBeenCalledTimes(1);
      expect(staged.abort).not.toHaveBeenCalled();
    });

    it('aborts the staged artifact and rethrows the original insert error when the row does not land', async () => {
      const insertError = new Error('SQLITE_FULL: database or disk is full');
      insertRejects(insertError);
      const staged = fakeStaged();

      await expect(run({ staged })).rejects.toBe(insertError);

      expect(staged.abort).toHaveBeenCalledTimes(1);
      expect(staged.commit).not.toHaveBeenCalled();
      expect(removeDownload).not.toHaveBeenCalled();
      expect(warnsMatching('orphaned external download')).toHaveLength(0);
    });

    it('still rethrows the insert error, and logs the abort failure, when the discard fails', async () => {
      const insertError = new Error('SQLITE_FULL');
      insertRejects(insertError);
      const abortError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      const staged = fakeStaged({ abort: vi.fn().mockRejectedValue(abortError) });

      await expect(run({ staged })).rejects.toBe(insertError);

      const [logged] = warnCalls().at(-1)!;
      expect(logged.error).not.toBeInstanceOf(Error);
      expect(logged.error).toMatchObject({ type: 'Error', code: 'EACCES', message: 'EACCES: permission denied' });
    });

    it('writes a handoff row: completed, full progress, a completion time and no external id', async () => {
      const { release, values } = gateInsert();
      const staged = fakeStaged();

      const running = run({ staged });
      release();
      await running;

      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        clientStatus: 'completed',
        progress: 1,
        externalId: null,
        completedAt: expect.any(Date),
      }));
    });

    it('still writes a tracked row for an external id: downloading, no progress, no completion time', async () => {
      const { release, values } = gateInsert();

      const running = run({ externalId: 'ext-42' });
      release();
      await running;

      expect(values).toHaveBeenCalledWith(expect.objectContaining({
        clientStatus: 'downloading',
        progress: 0,
        externalId: 'ext-42',
        completedAt: undefined,
      }));
    });
  });

  describe('a publish that fails while the process is alive', () => {
    const commitError = () => new Error('EXDEV: cross-device link');

    function commitFails(): { staged: ReturnType<typeof fakeStaged>; error: Error } {
      const error = commitError();
      insertResolves();
      return { staged: fakeStaged({ commit: vi.fn().mockRejectedValue(error) }), error };
    }

    it('marks the orphaned row failed and idle, keyed on its own id, then discards the artifact', async () => {
      const { staged, error } = commitFails();
      const updateChain = mockDbChain([{ id: ROW_ID }]);
      db.update.mockReturnValue(updateChain);

      await expect(run({ staged })).rejects.toBe(error);

      expect(updateChain.set).toHaveBeenCalledTimes(1);
      const [payload] = updateChain.set.mock.calls[0]!;
      expect(payload).toMatchObject({ clientStatus: 'failed', pipelineStage: 'idle' });
      expect(String(payload.errorMessage).length).toBeGreaterThan(0);
      // A payload-only assertion cannot tell which row was repaired.
      expect(toSQL(updateChain.where.mock.calls[0]![0]).params).toContain(ROW_ID);
      expect(staged.abort).toHaveBeenCalledTimes(1);
    });

    it('warns with the row id and attempts nothing further when no row matches the repair', async () => {
      const { staged, error } = commitFails();
      db.update.mockReturnValue(mockDbChain([]));

      await expect(run({ staged })).rejects.toBe(error);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ id: ROW_ID }),
        expect.stringContaining('no row matched'),
      );
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(staged.abort).toHaveBeenCalledTimes(1);
    });

    it('leaves the row exactly as inserted when the repair itself rejects — the AC9 residue, reached in process', async () => {
      const { staged, error } = commitFails();
      const repairError = new Error('SQLITE_BUSY');
      db.update.mockReturnValue(mockDbChain([], { error: repairError }));

      await expect(run({ staged })).rejects.toBe(error);

      expect(warnsMatching('remains completed')[0]![0].error).toMatchObject({ type: 'Error', message: 'SQLITE_BUSY' });
      // No second transition: the row keeps the completed state the insert gave it.
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(staged.abort).toHaveBeenCalledTimes(1);
    });

    it('repairs before it discards, logs all three failures, and still rejects with the publish error', async () => {
      const trace: string[] = [];
      const error = commitError();
      insertResolves();
      const staged = fakeStaged({
        commit: vi.fn().mockRejectedValue(error),
        abort: vi.fn().mockImplementation(() => {
          trace.push('abort');
          return Promise.reject(new Error('EACCES'));
        }),
      });
      db.update.mockImplementation(() => {
        trace.push('repair');
        return mockDbChain([], { error: new Error('SQLITE_BUSY') });
      });

      await expect(run({ staged })).rejects.toBe(error);

      expect(trace).toEqual(['repair', 'abort']);
      expect(warnsMatching('could not be published')).toHaveLength(1);
      expect(warnsMatching('remains completed')).toHaveLength(1);
      expect(warnsMatching('stale temp file')).toHaveLength(1);
    });

    it('logs the publish failure with a serialized error, never the raw catch binding', async () => {
      const { staged, error } = commitFails();
      db.update.mockReturnValue(mockDbChain([{ id: ROW_ID }]));

      await expect(run({ staged })).rejects.toBe(error);

      const [publishWarn] = warnsMatching('could not be published');
      expect(publishWarn![0].error).not.toBeInstanceOf(Error);
      expect(publishWarn![0].error).toMatchObject({ type: 'Error', message: 'EXDEV: cross-device link' });
    });
  });

  describe('no staged handoff — the external-id compensation is untouched', () => {
    it('removes the orphaned external download with its files', async () => {
      const insertError = new Error('SQLITE_FULL');
      insertRejects(insertError);

      await expect(run({ externalId: 'ext-42' })).rejects.toBe(insertError);

      expect(getAdapter).toHaveBeenCalledWith(1);
      expect(removeDownload).toHaveBeenCalledWith('ext-42', true);
      expect(warnsMatching('orphaned external download')).toHaveLength(0);
    });

    it('warns that the compensation adapter is unavailable when the client is gone', async () => {
      insertRejects(new Error('SQLITE_FULL'));
      getAdapter.mockResolvedValue(null);

      await expect(run({ externalId: 'ext-42' })).rejects.toThrow('SQLITE_FULL');

      expect(log.warn).toHaveBeenCalledWith(
        { externalId: 'ext-42', clientId: 1 },
        'Download insert failed AND compensation adapter unavailable — orphaned external download (operator recovery needed)',
      );
    });

    it('warns that the compensating remove failed when the adapter rejects', async () => {
      insertRejects(new Error('SQLITE_FULL'));
      removeDownload.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(run({ externalId: 'ext-42' })).rejects.toThrow('SQLITE_FULL');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: 'ext-42', clientId: 1, error: expect.objectContaining({ type: 'Error' }) }),
        'Download insert failed AND compensation removeDownload failed — orphaned external download (operator recovery needed)',
      );
    });

    it('compensates nothing and warns nothing when a failed insert has neither an id nor a staged artifact', async () => {
      const insertError = new Error('SQLITE_FULL');
      insertRejects(insertError);

      await expect(run()).rejects.toBe(insertError);

      expect(getAdapter).not.toHaveBeenCalled();
      expect(removeDownload).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('issues no update and no adapter lookup on a successful unstaged insert', async () => {
      insertResolves();

      await expect(run({ externalId: 'ext-42' })).resolves.toEqual([{ id: ROW_ID }]);

      expect(db.update).not.toHaveBeenCalled();
      expect(getAdapter).not.toHaveBeenCalled();
    });
  });
});
