import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { enqueueAutoImport } from './enqueue-auto-import.js';

function createMockLogger(): FastifyBaseLogger {
  return {
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    trace: vi.fn(), fatal: vi.fn(), child: vi.fn().mockReturnThis(),
    level: 'info', silent: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function createMockDb(existingJobs: Array<{ id: number; metadata: string }> = []) {
  const insertChain = {
    values: vi.fn().mockResolvedValue(undefined),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue({ rowsAffected: 1 }),
  };
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(existingJobs),
  };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    _insertChain: insertChain,
    _updateChain: updateChain,
    _selectChain: selectChain,
  };
}

describe('enqueueAutoImport', () => {
  let log: FastifyBaseLogger;
  const nudge = vi.fn((): void => {});

  beforeEach(() => {
    log = createMockLogger();
    nudge.mockClear();
  });

  it('creates import_jobs row with type=auto and nudges worker', async () => {
    const db = createMockDb();
    const result = await enqueueAutoImport(db as never, 99, 42, nudge, log);

    expect(result).toBe(true);
    // insert called with correct payload
    expect(db.insert).toHaveBeenCalled();
    expect(db._insertChain.values).toHaveBeenCalledWith(expect.objectContaining({
      bookId: 42,
      type: 'auto',
      status: 'pending',
      phase: 'queued',
      metadata: JSON.stringify({ downloadId: 99 }),
    }));
    // download status is no longer mutated from this helper
    expect(db.update).not.toHaveBeenCalled();
    // worker nudged
    expect(nudge).toHaveBeenCalled();
  });

  it('skips duplicate — returns false when pending job already exists for same downloadId', async () => {
    const existing = [{ id: 5, metadata: JSON.stringify({ downloadId: 99 }) }];
    const db = createMockDb(existing);
    const result = await enqueueAutoImport(db as never, 99, 42, nudge, log);

    expect(result).toBe(false);
    // Should NOT insert or update
    expect(db.insert).not.toHaveBeenCalled();
    expect(nudge).not.toHaveBeenCalled();
  });

  it('allows job creation when existing job is for a different downloadId', async () => {
    const existing = [{ id: 5, metadata: JSON.stringify({ downloadId: 77 }) }];
    const db = createMockDb(existing);
    const result = await enqueueAutoImport(db as never, 99, 42, nudge, log);

    expect(result).toBe(true);
    expect(db.insert).toHaveBeenCalled();
    expect(nudge).toHaveBeenCalled();
  });
});
