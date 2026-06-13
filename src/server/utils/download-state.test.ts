import { describe, it, expect } from 'vitest';
import type { Mock } from 'vitest';
import { createMockDb, mockDbChain, inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import {
  transitionDownloadState,
  displayStatusCondition,
  displayStatusInCondition,
  completedDisplayDownloadCondition,
  completedCountDownloadCondition,
  inProgressDownloadCondition,
  terminalDownloadCondition,
  clientPolledDownloadCondition,
} from './download-state.js';

function setup(returning: unknown[] = []) {
  const db = createMockDb();
  const chain = mockDbChain(returning);
  db.update.mockReturnValue(chain);
  return { db: inject<Db>(db), chain };
}

function lastSetArg(chain: ReturnType<typeof mockDbChain>): Record<string, unknown> {
  return (chain.set as Mock).mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('transitionDownloadState', () => {
  it('omitted-axis non-clobber: a clientStatus-only call never includes pipelineStage in SET', async () => {
    const { db, chain } = setup();
    await transitionDownloadState(db, 1, { clientStatus: 'failed' });
    const set = lastSetArg(chain);
    expect(set).toEqual({ clientStatus: 'failed' });
    expect('pipelineStage' in set).toBe(false);
  });

  it('omitted-axis non-clobber: a pipelineStage-only call never includes clientStatus in SET', async () => {
    const { db, chain } = setup();
    await transitionDownloadState(db, 1, { pipelineStage: 'checking' });
    const set = lastSetArg(chain);
    expect(set).toEqual({ pipelineStage: 'checking' });
    expect('clientStatus' in set).toBe(false);
  });

  it('combined transition writes BOTH axes in one SET (the sanctioned failure tuple)', async () => {
    const { db, chain } = setup();
    await transitionDownloadState(db, 1, { clientStatus: 'failed', pipelineStage: 'idle' });
    expect(chain.set as Mock).toHaveBeenCalledTimes(1);
    expect(lastSetArg(chain)).toEqual({ clientStatus: 'failed', pipelineStage: 'idle' });
  });

  it('includes only the side fields that are provided', async () => {
    const { db, chain } = setup();
    const completedAt = new Date(0);
    await transitionDownloadState(db, 1, { clientStatus: 'completed', completedAt, progress: 1 });
    expect(lastSetArg(chain)).toEqual({ clientStatus: 'completed', completedAt, progress: 1 });
  });

  it('passes null side fields through (clearing pendingCleanup / errorMessage)', async () => {
    const { db, chain } = setup();
    await transitionDownloadState(db, 1, { pendingCleanup: null });
    expect(lastSetArg(chain)).toEqual({ pendingCleanup: null });
  });

  it('expected guard: returns true when the guarded UPDATE matched a row', async () => {
    const { db } = setup([{ id: 1 }]);
    const ok = await transitionDownloadState(db, 1, {
      expected: { clientStatus: 'completed', pipelineStage: 'idle' },
      pipelineStage: 'checking',
    });
    expect(ok).toBe(true);
  });

  it('expected guard: returns false when no row matched (no-op transition)', async () => {
    const { db } = setup([]);
    const ok = await transitionDownloadState(db, 1, {
      expected: { pipelineStage: 'pending_review' },
      pipelineStage: 'importing',
    });
    expect(ok).toBe(false);
  });
});

describe('display-status query conditions', () => {
  it('completedDisplayDownloadCondition equals displayStatusCondition("completed")', () => {
    expect(completedDisplayDownloadCondition()).toEqual(displayStatusCondition('completed'));
  });

  it('completedCountDownloadCondition equals displayStatusInCondition(completed,imported)', () => {
    expect(completedCountDownloadCondition()).toEqual(displayStatusInCondition(['completed', 'imported']));
  });

  it('builds defined SQL for every category condition', () => {
    expect(inProgressDownloadCondition()).toBeDefined();
    expect(terminalDownloadCondition()).toBeDefined();
    expect(clientPolledDownloadCondition()).toBeDefined();
    expect(displayStatusCondition('checking')).toBeDefined();
  });
});
