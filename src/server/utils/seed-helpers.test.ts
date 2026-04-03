import { describe, it, expect } from 'vitest';
import { isTorrentRemovalDeferred } from './seed-helpers.js';

describe('isTorrentRemovalDeferred', () => {
  const baseSettings = { minSeedTime: 60, minSeedRatio: 1.0 };

  describe('seed time gating', () => {
    it('returns true when seed time not elapsed (torrent protocol, minSeedTime > 0)', () => {
      const download = { completedAt: new Date(Date.now() - 30_000), protocol: 'torrent' as const }; // 30s ago, need 60min
      expect(isTorrentRemovalDeferred(download, { ...baseSettings, minSeedRatio: 0 }, 0)).toBe(true);
    });

    it('returns false when seed time elapsed (torrent protocol, minSeedTime > 0)', () => {
      const download = { completedAt: new Date(Date.now() - 3_700_000), protocol: 'torrent' as const }; // ~61min ago
      expect(isTorrentRemovalDeferred(download, { ...baseSettings, minSeedRatio: 0 }, 0)).toBe(false);
    });

    it('returns false when minSeedTime is 0 (disabled)', () => {
      const download = { completedAt: new Date(Date.now() - 30_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 0, minSeedRatio: 0 }, 0)).toBe(false);
    });

    it('at boundary: elapsed exactly equals minSeedTime → returns false (removal proceeds)', () => {
      const exactMs = 60 * 60_000; // 60 minutes
      const download = { completedAt: new Date(Date.now() - exactMs), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, { ...baseSettings, minSeedRatio: 0 }, 0)).toBe(false);
    });
  });

  describe('seed ratio gating', () => {
    it('returns true when ratio below threshold (torrent protocol, minSeedRatio > 0)', () => {
      const download = { completedAt: new Date(Date.now() - 3_700_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 0, minSeedRatio: 1.0 }, 0.5)).toBe(true);
    });

    it('returns false when ratio at threshold (strictly-less-than semantics)', () => {
      const download = { completedAt: new Date(Date.now() - 3_700_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 0, minSeedRatio: 1.0 }, 1.0)).toBe(false);
    });

    it('returns false when ratio above threshold', () => {
      const download = { completedAt: new Date(Date.now() - 3_700_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 0, minSeedRatio: 1.0 }, 1.5)).toBe(false);
    });

    it('returns false when minSeedRatio is 0 (disabled)', () => {
      const download = { completedAt: new Date(Date.now() - 3_700_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 0, minSeedRatio: 0 }, 0)).toBe(false);
    });
  });

  describe('combined conditions', () => {
    it('returns true when seed time met but ratio not met', () => {
      const download = { completedAt: new Date(Date.now() - 3_700_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, baseSettings, 0.5)).toBe(true);
    });

    it('returns true when ratio met but seed time not met', () => {
      const download = { completedAt: new Date(Date.now() - 30_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, baseSettings, 1.5)).toBe(true);
    });

    it('returns false when both seed time and ratio met', () => {
      const download = { completedAt: new Date(Date.now() - 3_700_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, baseSettings, 1.5)).toBe(false);
    });

    it('returns false when both minSeedTime and minSeedRatio are 0', () => {
      const download = { completedAt: new Date(Date.now() - 30_000), protocol: 'torrent' as const };
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 0, minSeedRatio: 0 }, 0)).toBe(false);
    });
  });

  describe('protocol handling', () => {
    it('returns false for non-torrent protocol (usenet) regardless of settings', () => {
      const download = { completedAt: new Date(Date.now() - 30_000), protocol: 'usenet' as const };
      expect(isTorrentRemovalDeferred(download, baseSettings, 0)).toBe(false);
    });

    it('returns false for non-torrent protocol even with both thresholds configured', () => {
      const download = { completedAt: new Date(Date.now() - 30_000), protocol: 'usenet' as const };
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 120, minSeedRatio: 2.0 }, 0)).toBe(false);
    });
  });

  describe('null/missing data', () => {
    it('handles null completedAt — seed time check skipped, ratio still applies', () => {
      const download = { completedAt: null, protocol: 'torrent' as const };
      // Ratio below threshold → deferred
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 60, minSeedRatio: 1.0 }, 0.5)).toBe(true);
      // Ratio met → not deferred (seed time skipped because no completedAt)
      expect(isTorrentRemovalDeferred(download, { minSeedTime: 60, minSeedRatio: 1.0 }, 1.0)).toBe(false);
    });
  });
});
