import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq, or, gt, and, lte, inArray } from 'drizzle-orm';
import { BlacklistService } from './blacklist.service.js';
import { blacklist } from '../../db/schema.js';
import { createMockDb, createMockLogger, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';

vi.mock('drizzle-orm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn(actual.eq),
    or: vi.fn(actual.or),
    gt: vi.fn(actual.gt),
    and: vi.fn(actual.and),
    lte: vi.fn(actual.lte),
    inArray: vi.fn(actual.inArray),
  };
});

const mockEntry = {
  id: 1,
  bookId: null,
  infoHash: 'abc123def456',
  title: 'Bad Release [Unabridged]',
  reason: 'wrong_content',
  note: 'Not the right book',
  blacklistType: 'permanent',
  expiresAt: null,
  blacklistedAt: new Date(),
};

const mockEntry2 = {
  id: 2,
  bookId: 5,
  infoHash: 'xyz789',
  title: 'Spam Release',
  reason: 'spam',
  note: null,
  blacklistType: 'permanent',
  expiresAt: null,
  blacklistedAt: new Date(),
};

describe('BlacklistService', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let settingsService: ReturnType<typeof createMockSettingsService>;
  let service: BlacklistService;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    settingsService = createMockSettingsService();
    service = new BlacklistService(db as never, log as never, settingsService as never);
  });

  describe('getAll', () => {
    it('returns entries in { data, total } envelope', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 2 }]))
        .mockReturnValueOnce(mockDbChain([mockEntry, mockEntry2]));
      const result = await service.getAll();
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('returns empty data with total 0 when no entries', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(mockDbChain([]));
      const result = await service.getAll();
      expect(result).toEqual({ data: [], total: 0 });
    });

    it('applies limit and offset when provided', async () => {
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 50 }]))
        .mockReturnValueOnce(mockDbChain([mockEntry]));
      const result = await service.getAll({ limit: 10, offset: 20 });
      expect(result.total).toBe(50);
      expect(result.data).toHaveLength(1);
    });

    it('applies stable orderBy with blacklistedAt DESC, id DESC', async () => {
      const dataChain = mockDbChain([]);
      db.select
        .mockReturnValueOnce(mockDbChain([{ value: 0 }]))
        .mockReturnValueOnce(dataChain);

      await service.getAll();

      expect(dataChain.orderBy).toHaveBeenCalledTimes(1);
      const args = (dataChain.orderBy as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(args).toHaveLength(2);
    });
  });

  describe('getById', () => {
    it('returns entry when found', async () => {
      db.select.mockReturnValue(mockDbChain([mockEntry]));
      const result = await service.getById(1);
      expect(result).toEqual(mockEntry);
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('creates and returns entry', async () => {
      db.insert.mockReturnValue(mockDbChain([mockEntry]));
      const result = await service.create({
        infoHash: 'abc123def456',
        title: 'Bad Release [Unabridged]',
        reason: 'wrong_content',
        note: 'Not the right book',
      });
      expect(result).toEqual(mockEntry);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Bad Release [Unabridged]', infoHash: 'abc123def456' }),
        'Added to blacklist',
      );
    });
  });

  describe('delete', () => {
    it('deletes existing entry', async () => {
      db.select.mockReturnValue(mockDbChain([mockEntry]));
      db.delete.mockReturnValue(mockDbChain());
      const result = await service.delete(1);
      expect(result).toBe(true);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, title: 'Bad Release [Unabridged]' }),
        'Removed from blacklist',
      );
    });

    it('returns false for non-existent entry', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.delete(999);
      expect(result).toBe(false);
    });
  });

  describe('isBlacklisted', () => {
    it('returns true when hash is blacklisted', async () => {
      db.select.mockReturnValue(mockDbChain([mockEntry]));
      const result = await service.isBlacklisted('abc123def456');
      expect(result).toBe(true);
    });

    it('returns false when hash is not blacklisted', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.isBlacklisted('unknown');
      expect(result).toBe(false);
    });
  });

  describe('getBlacklistedHashes', () => {
    it('returns set of blacklisted hashes', async () => {
      db.select.mockReturnValue(mockDbChain([mockEntry, mockEntry2]));
      const result = await service.getBlacklistedHashes();
      expect(result).toBeInstanceOf(Set);
      expect(result.has('abc123def456')).toBe(true);
      expect(result.has('xyz789')).toBe(true);
    });

    it('filters by provided hashes', async () => {
      db.select.mockReturnValue(mockDbChain([mockEntry]));
      const result = await service.getBlacklistedHashes(['abc123def456']);
      expect(result.has('abc123def456')).toBe(true);
    });

    it('returns empty set when no matches', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.getBlacklistedHashes(['unknown']);
      expect(result.size).toBe(0);
    });

    it('excludes expired temporary entries (expires_at <= now)', async () => {
      const expiredEntry = {
        ...mockEntry,
        blacklistType: 'temporary',
        expiresAt: new Date(Date.now() - 1000),
      };
      // getBlacklistedHashes applies expiry filter, so expired entries won't be returned by DB
      const chain = mockDbChain([]);
      db.select.mockReturnValue(chain);
      const result = await service.getBlacklistedHashes([expiredEntry.infoHash]);
      expect(result.has(expiredEntry.infoHash)).toBe(false);

      // Assert the where predicate was applied (not skipped)
      expect(chain.where).toHaveBeenCalled();
    });

    it('builds expiry-aware predicate: permanent OR expires_at > now', async () => {
      vi.mocked(eq).mockClear();
      vi.mocked(or).mockClear();
      vi.mocked(gt).mockClear();

      db.select.mockReturnValue(mockDbChain([]));
      await service.getBlacklistedHashes();

      // Assert the predicate checks blacklistType = 'permanent'
      expect(eq).toHaveBeenCalledWith(blacklist.blacklistType, 'permanent');
      // Assert the predicate checks expiresAt > now (a Date instance)
      expect(gt).toHaveBeenCalledWith(blacklist.expiresAt, expect.any(Date));
      // Assert or() combines the two conditions
      expect(or).toHaveBeenCalled();
    });

    it('includes non-expired temporary entries in returned set', async () => {
      const temporaryEntry = {
        ...mockEntry,
        blacklistType: 'temporary',
        expiresAt: new Date(Date.now() + 86400000),
      };
      db.select.mockReturnValue(mockDbChain([temporaryEntry]));
      const result = await service.getBlacklistedHashes();
      expect(result.has(temporaryEntry.infoHash)).toBe(true);
    });

    it('includes permanent entries regardless of expires_at', async () => {
      db.select.mockReturnValue(mockDbChain([mockEntry]));
      const result = await service.getBlacklistedHashes();
      expect(result.has(mockEntry.infoHash)).toBe(true);
    });

    it('applies expiry filter where predicate to both hash-filtered and unfiltered queries', async () => {
      vi.mocked(or).mockClear();
      vi.mocked(eq).mockClear();
      vi.mocked(gt).mockClear();
      vi.mocked(and).mockClear();
      vi.mocked(inArray).mockClear();

      // Without hash filter — uses or(eq(permanent), gt(expiresAt, now))
      const chain1 = mockDbChain([]);
      db.select.mockReturnValue(chain1);
      await service.getBlacklistedHashes();
      expect(chain1.where).toHaveBeenCalledTimes(1);
      expect(or).toHaveBeenCalled();

      vi.mocked(or).mockClear();
      vi.mocked(and).mockClear();

      // With hash filter — uses and(inArray(hashes), or(permanent, gt(expiresAt, now)))
      const chain2 = mockDbChain([]);
      db.select.mockReturnValue(chain2);
      await service.getBlacklistedHashes(['abc123']);
      expect(chain2.where).toHaveBeenCalledTimes(1);
      expect(inArray).toHaveBeenCalledWith(blacklist.infoHash, ['abc123']);
      expect(and).toHaveBeenCalled();
    });
  });

  describe('create — blacklist type and TTL', () => {
    it('creates entry with blacklistType temporary and auto-fills expires_at from TTL setting', async () => {
      const temporaryEntry = {
        ...mockEntry,
        blacklistType: 'temporary',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };
      const chain = mockDbChain([temporaryEntry]);
      db.insert.mockReturnValue(chain);
      const result = await service.create({
        infoHash: 'abc123def456',
        title: 'Bad Release [Unabridged]',
        reason: 'wrong_content',
        blacklistType: 'temporary',
      });
      expect(result).toEqual(expect.objectContaining({ blacklistType: 'temporary' }));
      expect(result.expiresAt).not.toBeNull();
      expect(settingsService.get).toHaveBeenCalledWith('search');

      // Assert the actual values payload includes computed expiresAt
      const valuesPayload = (chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(valuesPayload.blacklistType).toBe('temporary');
      expect(valuesPayload.expiresAt).toBeInstanceOf(Date);
      // TTL is 7 days — verify expiresAt is approximately 7 days from now
      const expectedExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect(valuesPayload.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 5000);
      expect(valuesPayload.expiresAt.getTime()).toBeLessThan(expectedExpiry + 5000);
    });

    it('creates entry with blacklistType permanent and expires_at null', async () => {
      const permanentEntry = { ...mockEntry, blacklistType: 'permanent', expiresAt: null };
      const chain = mockDbChain([permanentEntry]);
      db.insert.mockReturnValue(chain);
      const result = await service.create({
        infoHash: 'abc123def456',
        title: 'Bad Release [Unabridged]',
        reason: 'wrong_content',
        blacklistType: 'permanent',
      });
      expect(result).toEqual(expect.objectContaining({ blacklistType: 'permanent', expiresAt: null }));

      // Assert the values payload explicitly nullifies expiresAt for permanent entries
      const valuesPayload = (chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(valuesPayload.blacklistType).toBe('permanent');
      expect(valuesPayload.expiresAt).toBeNull();
    });

    it('defaults to permanent when blacklistType not specified', async () => {
      const permanentEntry = { ...mockEntry, blacklistType: 'permanent', expiresAt: null };
      const chain = mockDbChain([permanentEntry]);
      db.insert.mockReturnValue(chain);
      const result = await service.create({
        infoHash: 'abc123def456',
        title: 'Bad Release [Unabridged]',
        reason: 'wrong_content',
      });
      expect(result).toEqual(expect.objectContaining({ expiresAt: null }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ blacklistType: 'permanent' }),
        'Added to blacklist',
      );

      // Assert the values payload nullifies expiresAt when no blacklistType specified
      const valuesPayload = (chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(valuesPayload.expiresAt).toBeNull();
    });
  });

  describe('toggleType', () => {
    it('toggling temporary→permanent sets expires_at to null and blacklistType to permanent', async () => {
      const temporaryEntry = {
        ...mockEntry,
        blacklistType: 'temporary',
        expiresAt: new Date(Date.now() + 86400000),
      };
      const toggledEntry = { ...temporaryEntry, blacklistType: 'permanent', expiresAt: null };
      db.select.mockReturnValue(mockDbChain([temporaryEntry]));
      const updateChain = mockDbChain([toggledEntry]);
      db.update.mockReturnValue(updateChain);
      const result = await service.toggleType(1, 'permanent');
      expect(result).toEqual(expect.objectContaining({ blacklistType: 'permanent', expiresAt: null }));
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, blacklistType: 'permanent', expiresAt: null }),
        'Blacklist entry type toggled',
      );

      // Assert the actual update payload nullifies expiresAt
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(setPayload).toEqual({ blacklistType: 'permanent', expiresAt: null });
    });

    it('toggling permanent→temporary calculates expires_at from current date + TTL setting', async () => {
      const toggledEntry = {
        ...mockEntry,
        blacklistType: 'temporary',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };
      db.select.mockReturnValue(mockDbChain([mockEntry]));
      const updateChain = mockDbChain([toggledEntry]);
      db.update.mockReturnValue(updateChain);
      const result = await service.toggleType(1, 'temporary');
      expect(result).toEqual(expect.objectContaining({ blacklistType: 'temporary' }));
      expect(result!.expiresAt).not.toBeNull();
      expect(settingsService.get).toHaveBeenCalledWith('search');

      // Assert the actual update payload includes computed expiresAt from TTL
      const setPayload = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(setPayload.blacklistType).toBe('temporary');
      expect(setPayload.expiresAt).toBeInstanceOf(Date);
      const expectedExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      expect(setPayload.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 5000);
      expect(setPayload.expiresAt.getTime()).toBeLessThan(expectedExpiry + 5000);
    });

    it('returns null when entry not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.toggleType(999, 'permanent');
      expect(result).toBeNull();
    });
  });

  describe('deleteExpired', () => {
    it('deletes only expired temporary entries (expires_at <= now AND blacklistType = temporary)', async () => {
      vi.mocked(eq).mockClear();
      vi.mocked(and).mockClear();
      vi.mocked(lte).mockClear();

      const expiredEntry = {
        ...mockEntry,
        blacklistType: 'temporary',
        expiresAt: new Date(Date.now() - 1000),
      };
      const chain = mockDbChain([expiredEntry]);
      db.delete.mockReturnValue(chain);
      const count = await service.deleteExpired();
      expect(count).toBe(1);
      expect(db.delete).toHaveBeenCalled();

      // Assert the exact safety predicate: blacklistType = 'temporary' AND expiresAt <= now
      expect(eq).toHaveBeenCalledWith(blacklist.blacklistType, 'temporary');
      expect(lte).toHaveBeenCalledWith(blacklist.expiresAt, expect.any(Date));
      expect(and).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalledTimes(1);
    });

    it('does not delete permanent entries', async () => {
      vi.mocked(eq).mockClear();
      vi.mocked(and).mockClear();
      vi.mocked(lte).mockClear();

      const chain = mockDbChain([]);
      db.delete.mockReturnValue(chain);
      const count = await service.deleteExpired();
      expect(count).toBe(0);
      // The where clause filters to only temporary + expired, so permanent entries are never touched
      expect(db.delete).toHaveBeenCalled();
      // Assert the safety predicate is always applied even when result is empty
      expect(eq).toHaveBeenCalledWith(blacklist.blacklistType, 'temporary');
      expect(lte).toHaveBeenCalledWith(blacklist.expiresAt, expect.any(Date));
      expect(and).toHaveBeenCalled();
      expect(chain.where).toHaveBeenCalledTimes(1);
    });

    it('returns count of deleted entries', async () => {
      const expired1 = { ...mockEntry, id: 10, blacklistType: 'temporary', expiresAt: new Date(Date.now() - 1000) };
      const expired2 = { ...mockEntry2, id: 11, blacklistType: 'temporary', expiresAt: new Date(Date.now() - 2000) };
      db.delete.mockReturnValue(mockDbChain([expired1, expired2]));
      const count = await service.deleteExpired();
      expect(count).toBe(2);
      expect(log.info).toHaveBeenCalledWith({ count: 2 }, 'Cleaned up expired temporary blacklist entries');
    });

    it('handles zero expired entries gracefully (no-op)', async () => {
      db.delete.mockReturnValue(mockDbChain([]));
      const count = await service.deleteExpired();
      expect(count).toBe(0);
      expect(log.info).not.toHaveBeenCalled();
    });
  });
});
