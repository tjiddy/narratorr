import { describe, it, expect } from 'vitest';
import { downloadStatusSchema, clientStatusSchema, pipelineStageSchema } from './schemas.js';
import {
  DOWNLOAD_STATUS_REGISTRY,
  isInProgressStatus,
  isTerminalStatus,
  getInProgressStatuses,
  getTerminalStatuses,
  getCompletedStatuses,
  getClientPolledStatuses,
  getReplaceableStatuses,
  deriveDisplayStatus,
  displayStatusToTuple,
  isInProgressState,
  isTerminalState,
  isReplaceableState,
  isClientPolledState,
} from './download-status-registry.js';

describe('download-status-registry', () => {
  const allStatuses = downloadStatusSchema.options;

  describe('registry completeness', () => {
    it('every downloadStatusSchema value has an entry in the registry', () => {
      for (const status of allStatuses) {
        expect(DOWNLOAD_STATUS_REGISTRY[status]).toBeDefined();
      }
    });

    it('inProgress and terminal partitions are exhaustive — union equals full status set', () => {
      const inProgress = getInProgressStatuses();
      const terminal = getTerminalStatuses();
      const union = [...inProgress, ...terminal].sort();
      expect(union).toEqual([...allStatuses].sort());
    });

    it('no status appears in multiple categories (partitions are disjoint)', () => {
      const inProgress = new Set(getInProgressStatuses());
      const terminal = new Set(getTerminalStatuses());
      for (const status of inProgress) {
        expect(terminal.has(status)).toBe(false);
      }
    });
  });

  describe('isInProgressStatus', () => {
    it.each(['queued', 'downloading', 'paused', 'checking', 'pending_review', 'importing'] as const)(
      'returns true for %s',
      (status) => {
        expect(isInProgressStatus(status)).toBe(true);
      },
    );

    it.each(['completed', 'imported', 'failed'] as const)(
      'returns false for %s',
      (status) => {
        expect(isInProgressStatus(status)).toBe(false);
      },
    );

    it('returns false for unknown/invalid status string', () => {
      expect(isInProgressStatus('nonexistent')).toBe(false);
      expect(isInProgressStatus('')).toBe(false);
    });
  });

  describe('isTerminalStatus', () => {
    it.each(['completed', 'imported', 'failed'] as const)(
      'returns true for %s',
      (status) => {
        expect(isTerminalStatus(status)).toBe(true);
      },
    );

    it.each(['queued', 'downloading', 'paused', 'checking', 'pending_review', 'importing'] as const)(
      'returns false for %s',
      (status) => {
        expect(isTerminalStatus(status)).toBe(false);
      },
    );

    it('returns false for unknown/invalid status string', () => {
      expect(isTerminalStatus('nonexistent')).toBe(false);
      expect(isTerminalStatus('')).toBe(false);
    });
  });

  describe('getInProgressStatuses', () => {
    it('returns all 6 in-progress statuses', () => {
      const statuses = getInProgressStatuses();
      expect(statuses).toHaveLength(6);
      expect(statuses).toEqual(
        expect.arrayContaining(['queued', 'downloading', 'paused', 'checking', 'pending_review', 'importing']),
      );
    });
  });

  describe('getTerminalStatuses', () => {
    it('returns all 3 terminal statuses', () => {
      const statuses = getTerminalStatuses();
      expect(statuses).toHaveLength(3);
      expect(statuses).toEqual(
        expect.arrayContaining(['completed', 'imported', 'failed']),
      );
    });
  });

  describe('getCompletedStatuses', () => {
    it('returns terminal statuses excluding failed', () => {
      const completed = getCompletedStatuses();
      const terminal = getTerminalStatuses();
      expect(completed).not.toContain('failed');
      expect(completed.length).toBe(terminal.length - 1);
      for (const s of completed) {
        expect(terminal).toContain(s);
      }
    });

    it('includes completed and imported', () => {
      const completed = getCompletedStatuses();
      expect(completed).toContain('completed');
      expect(completed).toContain('imported');
    });
  });

  describe('completed status label rename', () => {
    it('completed entry label is "Downloaded"', () => {
      expect(DOWNLOAD_STATUS_REGISTRY.completed.label).toBe('Downloaded');
    });

    it('completed icon differs from imported icon', () => {
      expect(DOWNLOAD_STATUS_REGISTRY.completed.icon).not.toBe(DOWNLOAD_STATUS_REGISTRY.imported.icon);
    });

    it('completed color scheme differs from imported success styling', () => {
      expect(DOWNLOAD_STATUS_REGISTRY.completed.color).not.toBe(DOWNLOAD_STATUS_REGISTRY.imported.color);
      expect(DOWNLOAD_STATUS_REGISTRY.completed.bgColor).not.toBe(DOWNLOAD_STATUS_REGISTRY.imported.bgColor);
      expect(DOWNLOAD_STATUS_REGISTRY.completed.textColor).not.toBe(DOWNLOAD_STATUS_REGISTRY.imported.textColor);
    });

    it('imported entry label remains "Imported" with success styling unchanged', () => {
      expect(DOWNLOAD_STATUS_REGISTRY.imported.label).toBe('Imported');
      expect(DOWNLOAD_STATUS_REGISTRY.imported.color).toBe('text-success');
      expect(DOWNLOAD_STATUS_REGISTRY.imported.bgColor).toBe('bg-success/10');
      expect(DOWNLOAD_STATUS_REGISTRY.imported.textColor).toBe('text-success');
    });
  });

  describe('getClientPolledStatuses', () => {
    it('returns the three client-polled statuses', () => {
      const statuses = getClientPolledStatuses();
      expect(statuses).toHaveLength(3);
      expect(statuses).toEqual(expect.arrayContaining(['downloading', 'queued', 'paused']));
    });

    it('does not include internal pipeline statuses', () => {
      const statuses = getClientPolledStatuses();
      for (const s of ['checking', 'pending_review', 'importing', 'completed', 'imported', 'failed'] as const) {
        expect(statuses).not.toContain(s);
      }
    });
  });

  describe('visual metadata', () => {
    it('every status has label, icon, color, bgColor, textColor', () => {
      for (const status of allStatuses) {
        const meta = DOWNLOAD_STATUS_REGISTRY[status];
        expect(meta.label).toBeTruthy();
        expect(meta.icon).toBeTruthy();
        expect(meta.color).toBeTruthy();
        expect(meta.bgColor).toBeTruthy();
        expect(meta.textColor).toBeTruthy();
      }
    });

    it('registry keys exactly match Zod schema options', () => {
      const registryKeys = Object.keys(DOWNLOAD_STATUS_REGISTRY).sort();
      expect(registryKeys).toEqual([...allStatuses].sort());
    });
  });

  describe('getReplaceableStatuses', () => {
    it('returns exactly the five replaceable statuses', () => {
      expect(getReplaceableStatuses().sort()).toEqual(
        ['checking', 'downloading', 'paused', 'pending_review', 'queued'],
      );
    });

    it('excludes importing (import-pipeline status)', () => {
      const replaceable = getReplaceableStatuses();
      expect(replaceable).not.toContain('importing');
    });
  });

  // ── Two-axis derivation (#1445) ─────────────────────────────────────────
  describe('deriveDisplayStatus / displayStatusToTuple', () => {
    it('is a bijection: deriveDisplayStatus(displayStatusToTuple(s)) === s for every display status', () => {
      for (const s of allStatuses) {
        const { clientStatus, pipelineStage } = displayStatusToTuple(s);
        expect(deriveDisplayStatus(clientStatus, pipelineStage)).toBe(s);
      }
    });

    it('maps the overloaded pipeline values onto clientStatus=completed', () => {
      for (const s of ['checking', 'pending_review', 'importing', 'imported'] as const) {
        expect(displayStatusToTuple(s)).toEqual({ clientStatus: 'completed', pipelineStage: s });
      }
    });

    it('maps client-only values onto pipelineStage=idle (including the failure tuple)', () => {
      for (const s of ['queued', 'downloading', 'paused', 'completed', 'failed'] as const) {
        expect(displayStatusToTuple(s)).toEqual({ clientStatus: s, pipelineStage: 'idle' });
      }
      // The canonical failure tuple resolves to display `failed`.
      expect(deriveDisplayStatus('failed', 'idle')).toBe('failed');
    });

    it('pipeline stage wins over clientStatus whenever the stage is non-idle', () => {
      // A completed client download mid-pipeline always shows the pipeline stage.
      expect(deriveDisplayStatus('completed', 'checking')).toBe('checking');
      expect(deriveDisplayStatus('completed', 'importing')).toBe('importing');
      expect(deriveDisplayStatus('completed', 'imported')).toBe('imported');
    });
  });

  describe('tuple predicates over the full (clientStatus, pipelineStage) product', () => {
    const clientStatuses = clientStatusSchema.options;
    const pipelineStages = pipelineStageSchema.options;

    it('isInProgressState matches isInProgressStatus(deriveDisplayStatus(...)) for every tuple', () => {
      for (const c of clientStatuses) {
        for (const p of pipelineStages) {
          expect(isInProgressState(c, p)).toBe(isInProgressStatus(deriveDisplayStatus(c, p)));
        }
      }
    });

    it('isTerminalState matches isTerminalStatus(deriveDisplayStatus(...)) for every tuple', () => {
      for (const c of clientStatuses) {
        for (const p of pipelineStages) {
          expect(isTerminalState(c, p)).toBe(isTerminalStatus(deriveDisplayStatus(c, p)));
        }
      }
    });

    it('a download with pipelineStage=importing is NOT replaceable (load-bearing invariant)', () => {
      for (const c of clientStatuses) {
        expect(isReplaceableState(c, 'importing')).toBe(false);
      }
    });

    it('isReplaceableState matches getReplaceableStatuses() membership for every tuple', () => {
      const replaceable = new Set(getReplaceableStatuses());
      for (const c of clientStatuses) {
        for (const p of pipelineStages) {
          expect(isReplaceableState(c, p)).toBe(replaceable.has(deriveDisplayStatus(c, p)));
        }
      }
    });

    it('isClientPolledState is true only for pipeline-idle queued/downloading/paused rows', () => {
      const polled = new Set(getClientPolledStatuses());
      for (const c of clientStatuses) {
        for (const p of pipelineStages) {
          expect(isClientPolledState(c, p)).toBe(polled.has(deriveDisplayStatus(c, p)));
        }
      }
      // Concretely: a completed client status with idle stage is never polled.
      expect(isClientPolledState('completed', 'idle')).toBe(false);
      expect(isClientPolledState('downloading', 'idle')).toBe(true);
      expect(isClientPolledState('downloading', 'checking')).toBe(false);
    });
  });
});
