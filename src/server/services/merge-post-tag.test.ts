import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('node:fs/promises', () => ({ stat: vi.fn() }));

import { stat } from 'node:fs/promises';
import { retagMergedOutput } from './merge-post-tag.js';
import { RetagError } from './tagging.service.js';

function createLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function createDeps(overrides: {
  taggingEnabled?: boolean;
  retagBookWithinAdmissionLock?: Mock;
  taggingService?: unknown;
} = {}) {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  const log = createLog();
  const retagBookWithinAdmissionLock = overrides.retagBookWithinAdmissionLock ?? vi.fn().mockResolvedValue({
    bookId: 1, tagged: 1, skipped: 0, failed: 0, warnings: [], refreshItem: null,
  });

  const deps = {
    db: { update } as never,
    settingsService: { get: vi.fn().mockResolvedValue({ enabled: overrides.taggingEnabled ?? true }) } as never,
    log: log as never,
    taggingService: ('taggingService' in overrides ? overrides.taggingService : { retagBookWithinAdmissionLock }) as never,
  };

  return { deps, log, retagBookWithinAdmissionLock, update, set, where };
}

beforeEach(() => {
  vi.clearAllMocks();
  (stat as Mock).mockResolvedValue({ size: 2000 });
});

describe('retagMergedOutput — error isolation (#2210 AC13)', () => {
  it('logs and returns [] when the tag writer dependency is missing, never rethrowing', async () => {
    const retagBookWithinAdmissionLock = vi.fn().mockRejectedValue(
      new RetagError('MUTAGEN_NOT_CONFIGURED', 'Python with the mutagen module is not available on this system.'),
    );
    const { deps, log } = createDeps({ retagBookWithinAdmissionLock });

    // A committed merge must never become merge_failed because tagging could not run.
    await expect(retagMergedOutput(deps, 1, '/library/book/out.m4b')).resolves.toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it('returns [] without calling retagBookWithinAdmissionLock when tagging is disabled', async () => {
    const { deps, retagBookWithinAdmissionLock } = createDeps({ taggingEnabled: false });

    expect(await retagMergedOutput(deps, 1, '/library/book/out.m4b')).toEqual([]);
    expect(retagBookWithinAdmissionLock).not.toHaveBeenCalled();
  });

  it('warns and returns [] when tagging is enabled but no tagging service is wired', async () => {
    const { deps, log } = createDeps({ taggingService: undefined });

    expect(await retagMergedOutput(deps, 1, '/library/book/out.m4b')).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith({ bookId: 1 }, expect.stringContaining('no tagging service'));
  });

  it('surfaces the retag warnings on a partial failure without throwing', async () => {
    const retagBookWithinAdmissionLock = vi.fn().mockResolvedValue({
      bookId: 1, tagged: 1, skipped: 0, failed: 1, warnings: ['ch02.m4b: Tag verification failed for: ©nam'], refreshItem: null,
    });
    const { deps, log } = createDeps({ retagBookWithinAdmissionLock });

    const warnings = await retagMergedOutput(deps, 1, '/library/book/out.m4b');

    expect(warnings).toEqual(['ch02.m4b: Tag verification failed for: ©nam']);
    expect(log.warn).toHaveBeenCalledWith({ bookId: 1, failed: 1 }, expect.stringContaining('reported failures'));
  });
});

describe('retagMergedOutput — books.size refresh', () => {
  it.each([
    ['grew', 3000],
    ['shrank', 1200],
  ])('refreshes books.size from disk when the file %s', async (_label, size) => {
    (stat as Mock).mockResolvedValue({ size });
    const { deps, set } = createDeps();

    await retagMergedOutput(deps, 1, '/library/book/out.m4b');

    // An in-place overwrite can legitimately shrink the file, so the refresh must not be
    // conditional on growth (#2210 D2).
    expect(stat).toHaveBeenCalledWith('/library/book/out.m4b');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ size }));
  });

  it('skips the size refresh when nothing was tagged', async () => {
    const retagBookWithinAdmissionLock = vi.fn().mockResolvedValue({
      bookId: 1, tagged: 0, skipped: 1, failed: 0, warnings: [], refreshItem: null,
    });
    const { deps, update } = createDeps({ retagBookWithinAdmissionLock });

    await retagMergedOutput(deps, 1, '/library/book/out.m4b');

    expect(stat).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
