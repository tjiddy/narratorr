import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, or, gt, and, lte, inArray } from 'drizzle-orm';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { BlacklistService } from './blacklist.service.js';
import { blacklist, books } from '../../db/schema.js';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';

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
    // Schema validation
    it('returns true when infoHash matches a permanent entry', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(['abc123']),
        blacklistedGuids: new Set(),
      });
      const result = await service.isBlacklisted('abc123');
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledWith(['abc123'], undefined);
      spy.mockRestore();
    });

    it('returns true when guid matches a permanent entry', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(),
        blacklistedGuids: new Set(['guid-123']),
      });
      const result = await service.isBlacklisted(undefined, 'guid-123');
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledWith(undefined, ['guid-123']);
      spy.mockRestore();
    });

    it('returns true when infoHash matches but guid does not (both provided)', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(['abc123']),
        blacklistedGuids: new Set(),
      });
      const result = await service.isBlacklisted('abc123', 'no-match-guid');
      expect(result).toBe(true);
      spy.mockRestore();
    });

    it('returns true when guid matches but infoHash does not (both provided)', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(),
        blacklistedGuids: new Set(['guid-hit']),
      });
      const result = await service.isBlacklisted('hash-miss', 'guid-hit');
      expect(result).toBe(true);
      spy.mockRestore();
    });

    it('returns false when neither identifier is provided', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers');
      const result = await service.isBlacklisted();
      expect(result).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    // Boundary values — guid-only and infoHash-only DB entries
    it('detects guid-only blacklist entry when guid is passed', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(),
        blacklistedGuids: new Set(['usenet-guid']),
      });
      const result = await service.isBlacklisted(undefined, 'usenet-guid');
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledWith(undefined, ['usenet-guid']);
      spy.mockRestore();
    });

    it('detects infoHash-only blacklist entry when infoHash is passed', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(['torrent-hash']),
        blacklistedGuids: new Set(),
      });
      const result = await service.isBlacklisted('torrent-hash');
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledWith(['torrent-hash'], undefined);
      spy.mockRestore();
    });

    // Null/missing data paths
    it('passes only infoHash when guid is undefined', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(),
        blacklistedGuids: new Set(),
      });
      await service.isBlacklisted('hash-only');
      expect(spy).toHaveBeenCalledWith(['hash-only'], undefined);
      spy.mockRestore();
    });

    it('passes only guid when infoHash is undefined', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(),
        blacklistedGuids: new Set(),
      });
      await service.isBlacklisted(undefined, 'guid-only');
      expect(spy).toHaveBeenCalledWith(undefined, ['guid-only']);
      spy.mockRestore();
    });

    // Expiry handling — integration tests through getBlacklistedIdentifiers (no spy)
    it('detects permanent infoHash-only entry', async () => {
      const entry = { ...mockEntry, infoHash: 'perm-hash', guid: null, blacklistType: 'permanent', expiresAt: null };
      db.select.mockReturnValue(mockDbChain([entry]));
      const result = await service.isBlacklisted('perm-hash');
      expect(result).toBe(true);
    });

    it('detects permanent guid-only entry', async () => {
      const entry = { ...mockEntry, infoHash: null, guid: 'perm-guid', blacklistType: 'permanent', expiresAt: null };
      db.select.mockReturnValue(mockDbChain([entry]));
      const result = await service.isBlacklisted(undefined, 'perm-guid');
      expect(result).toBe(true);
    });

    it('detects temporary infoHash-only entry that has not expired', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const entry = { ...mockEntry, infoHash: 'temp-hash', guid: null, blacklistType: 'temporary', expiresAt: futureDate };
      db.select.mockReturnValue(mockDbChain([entry]));
      const result = await service.isBlacklisted('temp-hash');
      expect(result).toBe(true);
    });

    it('detects temporary guid-only entry that has not expired', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const entry = { ...mockEntry, infoHash: null, guid: 'temp-guid', blacklistType: 'temporary', expiresAt: futureDate };
      db.select.mockReturnValue(mockDbChain([entry]));
      const result = await service.isBlacklisted(undefined, 'temp-guid');
      expect(result).toBe(true);
    });

    it('does NOT detect temporary infoHash-only entry that has expired', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.isBlacklisted('expired-hash');
      expect(result).toBe(false);
    });

    it('does NOT detect temporary guid-only entry that has expired', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.isBlacklisted(undefined, 'expired-guid');
      expect(result).toBe(false);
    });

    // Delegation verification
    it('delegates to getBlacklistedIdentifiers for dual-field + expiry logic', async () => {
      const spy = vi.spyOn(service, 'getBlacklistedIdentifiers').mockResolvedValue({
        blacklistedHashes: new Set(['h1']),
        blacklistedGuids: new Set(['g1']),
      });
      const result = await service.isBlacklisted('h1', 'g1');
      expect(result).toBe(true);
      expect(spy).toHaveBeenCalledWith(['h1'], ['g1']);
      spy.mockRestore();
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

  // ===== #248 — GUID blacklisting =====

  describe('create — guid support', () => {
    it('creates blacklist entry with guid only (infoHash null)', async () => {
      const guidEntry = { ...mockEntry, infoHash: null, guid: 'test-guid-123' };
      db.insert.mockReturnValue(mockDbChain([guidEntry]));
      const result = await service.create({
        guid: 'test-guid-123',
        title: 'Guid Only Release',
        reason: 'wrong_content',
      });
      expect(result).toEqual(guidEntry);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ guid: 'test-guid-123' }),
        'Added to blacklist',
      );
    });

    it('creates blacklist entry with both infoHash and guid', async () => {
      const bothEntry = { ...mockEntry, infoHash: 'abc123', guid: 'test-guid-456' };
      db.insert.mockReturnValue(mockDbChain([bothEntry]));
      const result = await service.create({
        infoHash: 'abc123',
        guid: 'test-guid-456',
        title: 'Both IDs Release',
        reason: 'wrong_content',
      });
      expect(result).toEqual(bothEntry);
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ infoHash: 'abc123', guid: 'test-guid-456' }),
        'Added to blacklist',
      );
    });

    it('rejects entry with neither infoHash nor guid', async () => {
      await expect(service.create({
        title: 'No IDs Release',
        reason: 'wrong_content',
      })).rejects.toThrow('Blacklist entry requires at least one identifier (infoHash or guid)');
      expect(db.insert).not.toHaveBeenCalled();
    });
  });

  describe('getBlacklistedIdentifiers', () => {
    it('returns blacklisted hashes and guids from combined query', async () => {
      const hashEntry = { ...mockEntry, infoHash: 'hash1', guid: null };
      const guidEntry = { ...mockEntry2, infoHash: null, guid: 'guid1' };
      db.select.mockReturnValue(mockDbChain([hashEntry, guidEntry]));
      const result = await service.getBlacklistedIdentifiers(['hash1'], ['guid1']);
      expect(result.blacklistedHashes).toBeInstanceOf(Set);
      expect(result.blacklistedGuids).toBeInstanceOf(Set);
      expect(result.blacklistedHashes.has('hash1')).toBe(true);
      expect(result.blacklistedGuids.has('guid1')).toBe(true);
    });

    it('returns empty sets when no identifiers match', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.getBlacklistedIdentifiers(['unknown-hash'], ['unknown-guid']);
      expect(result.blacklistedHashes.size).toBe(0);
      expect(result.blacklistedGuids.size).toBe(0);
    });

    it('handles empty input arrays gracefully', async () => {
      db.select.mockReturnValue(mockDbChain([]));
      const result = await service.getBlacklistedIdentifiers([], []);
      expect(result.blacklistedHashes.size).toBe(0);
      expect(result.blacklistedGuids.size).toBe(0);
    });

    it('filters by infoHash only when guid array is empty', async () => {
      vi.mocked(inArray).mockClear();
      db.select.mockReturnValue(mockDbChain([mockEntry]));
      await service.getBlacklistedIdentifiers(['abc123def456'], []);
      expect(inArray).toHaveBeenCalledWith(blacklist.infoHash, ['abc123def456']);
    });

    it('filters by guid only when infoHash array is empty', async () => {
      vi.mocked(inArray).mockClear();
      db.select.mockReturnValue(mockDbChain([{ ...mockEntry2, guid: 'guid1' }]));
      await service.getBlacklistedIdentifiers([], ['guid1']);
      expect(inArray).toHaveBeenCalledWith(blacklist.guid, ['guid1']);
    });

    it('queries both identifier columns with expiry filter when both arrays provided', async () => {
      vi.mocked(inArray).mockClear();
      vi.mocked(and).mockClear();
      vi.mocked(or).mockClear();
      const hashEntry = { ...mockEntry, infoHash: 'hash1', guid: null };
      const guidEntry = { ...mockEntry2, infoHash: null, guid: 'guid1' };
      db.select.mockReturnValue(mockDbChain([hashEntry, guidEntry]));

      const result = await service.getBlacklistedIdentifiers(['hash1'], ['guid1']);

      // Both identifier columns included in query
      expect(inArray).toHaveBeenCalledWith(blacklist.infoHash, ['hash1']);
      expect(inArray).toHaveBeenCalledWith(blacklist.guid, ['guid1']);
      // Expiry filter applied (or combines permanent + gt(expiresAt, now))
      expect(or).toHaveBeenCalled();
      // Combined with and()
      expect(and).toHaveBeenCalled();
      // Returned sets correctly partitioned
      expect(result.blacklistedHashes).toEqual(new Set(['hash1']));
      expect(result.blacklistedGuids).toEqual(new Set(['guid1']));
    });

    it('excludes null identifiers from returned sets', async () => {
      const mixedEntry = { ...mockEntry, infoHash: 'hash1', guid: null };
      db.select.mockReturnValue(mockDbChain([mixedEntry]));
      const result = await service.getBlacklistedIdentifiers(['hash1'], []);
      expect(result.blacklistedHashes).toEqual(new Set(['hash1']));
      expect(result.blacklistedGuids.size).toBe(0);
    });
  });

  describe('getBlacklistedHashes — backward compatibility', () => {
    it('delegates to getBlacklistedIdentifiers and returns hash set only', async () => {
      const hashEntry = { ...mockEntry, infoHash: 'hash1', guid: 'guid1' };
      db.select.mockReturnValue(mockDbChain([hashEntry]));
      const result = await service.getBlacklistedHashes(['hash1']);
      expect(result).toBeInstanceOf(Set);
      expect(result.has('hash1')).toBe(true);
      // Should not return guids — only hashes
      expect(result.has('guid1')).toBe(false);
    });
  });

  // ===== #736 — upsert call shape and normalization =====

  describe('create — upsert call shape', () => {
    it('dispatches conflict to info_hash when infoHash is populated', async () => {
      const chain = mockDbChain([mockEntry]);
      db.insert.mockReturnValue(chain);
      await service.create({ infoHash: 'abc', title: 'T', reason: 'spam' });

      const onConflict = chain.onConflictDoUpdate as ReturnType<typeof vi.fn>;
      expect(onConflict).toHaveBeenCalledTimes(1);
      const config = onConflict.mock.calls[0][0];
      expect(config.target).toBe(blacklist.infoHash);
      expect(config.targetWhere).toBeDefined();
      // set clause includes blacklistedAt refresh and every normalized column
      expect(config.set.blacklistedAt).toBeInstanceOf(Date);
      expect(config.set).toHaveProperty('infoHash', 'abc');
      expect(config.set).toHaveProperty('guid', null);
      expect(config.set).toHaveProperty('bookId', null);
      expect(config.set).toHaveProperty('note', null);
      expect(config.set).toHaveProperty('blacklistType', 'permanent');
      expect(config.set).toHaveProperty('expiresAt', null);
    });

    it('dispatches conflict to guid when only guid is populated', async () => {
      const chain = mockDbChain([{ ...mockEntry, infoHash: null, guid: 'g' }]);
      db.insert.mockReturnValue(chain);
      await service.create({ guid: 'g', title: 'T', reason: 'spam' });

      const onConflict = chain.onConflictDoUpdate as ReturnType<typeof vi.fn>;
      const config = onConflict.mock.calls[0][0];
      expect(config.target).toBe(blacklist.guid);
      expect(config.targetWhere).toBeDefined();
      expect(config.set).toHaveProperty('guid', 'g');
      expect(config.set).toHaveProperty('infoHash', null);
    });

    it('prefers info_hash conflict target when both identifiers are populated', async () => {
      const chain = mockDbChain([{ ...mockEntry, infoHash: 'h', guid: 'g' }]);
      db.insert.mockReturnValue(chain);
      await service.create({ infoHash: 'h', guid: 'g', title: 'T', reason: 'spam' });

      const config = (chain.onConflictDoUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.target).toBe(blacklist.infoHash);
      expect(config.set.infoHash).toBe('h');
      expect(config.set.guid).toBe('g');
    });

    it('normalizes omitted optional fields to null/permanent in values payload', async () => {
      const chain = mockDbChain([mockEntry]);
      db.insert.mockReturnValue(chain);
      await service.create({ infoHash: 'abc', title: 'T', reason: 'spam' });

      const valuesPayload = (chain.values as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(valuesPayload).toEqual({
        bookId: null,
        infoHash: 'abc',
        guid: null,
        title: 'T',
        reason: 'spam',
        note: null,
        blacklistType: 'permanent',
        expiresAt: null,
      });
    });

    it('normalizes the conflict-update set payload identically to values', async () => {
      const chain = mockDbChain([mockEntry]);
      db.insert.mockReturnValue(chain);
      await service.create({ infoHash: 'abc', title: 'T', reason: 'spam', bookId: 5 });

      const setPayload = (chain.onConflictDoUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0].set;
      // Every optional field is explicit in SET so omitted inputs don't leak stale values
      expect(setPayload).toMatchObject({
        bookId: 5,
        infoHash: 'abc',
        guid: null,
        title: 'T',
        reason: 'spam',
        note: null,
        blacklistType: 'permanent',
        expiresAt: null,
      });
    });
  });
});

// ===== #736 — integration tests against real libsql DB =====

describe('BlacklistService — upsert integration (real libsql)', () => {
  let dir: string;
  let db: Db;
  let service: BlacklistService;
  const log = createMockLogger();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'blacklist-upsert-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    service = new BlacklistService(db, inject(log));
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep the file handle on Windows — best effort
    }
  });

  async function allRows() {
    return db.select().from(blacklist).orderBy(blacklist.id);
  }

  it('hash-only second call upserts in place — single row, latest values', async () => {
    await service.create({ infoHash: 'abc', title: 'A', reason: 'spam' });
    await new Promise((r) => setTimeout(r, 10));
    await service.create({ infoHash: 'abc', title: 'A', reason: 'wrong_content', note: 'updated' });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      infoHash: 'abc',
      reason: 'wrong_content',
      note: 'updated',
    });
  });

  it('guid-only second call upserts in place', async () => {
    await service.create({ guid: 'xyz', title: 'B', reason: 'spam' });
    await service.create({ guid: 'xyz', title: 'B2', reason: 'wrong_content' });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guid: 'xyz', title: 'B2', reason: 'wrong_content' });
  });

  it('AC6a — hash matches existing row, new guid unowned: row is upserted with new guid', async () => {
    await service.create({ infoHash: 'h1', guid: 'g1', title: 'A', reason: 'spam' });
    await service.create({ infoHash: 'h1', guid: 'g2', title: 'A2', reason: 'wrong_content' });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ infoHash: 'h1', guid: 'g2', title: 'A2' });
  });

  it('AC6b — novel hash but guid collides with another row: rejects with UNIQUE error, no rows modified', async () => {
    await service.create({ infoHash: 'h1', guid: 'g1', title: 'A', reason: 'spam' });

    const error = await service
      .create({ infoHash: 'h2', guid: 'g1', title: 'B', reason: 'spam' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    // libsql wraps the SQLite error inside `cause` with the constraint name
    const cause = (error as Error & { cause?: { message?: string } }).cause;
    expect(cause?.message).toMatch(/UNIQUE constraint failed.*(?:guid|idx_blacklist_guid_unique)/);

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ infoHash: 'h1', guid: 'g1', title: 'A' });
  });

  it('AC6c — hash matches one row, guid matches a different row: rejects with UNIQUE error, BOTH rows unchanged', async () => {
    await service.create({ infoHash: 'h1', guid: 'g1', title: 'First', reason: 'spam' });
    await service.create({ infoHash: 'h2', guid: 'g2', title: 'Second', reason: 'spam' });

    const error = await service
      .create({ infoHash: 'h1', guid: 'g2', title: 'Merged', reason: 'wrong_content' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error & { cause?: { message?: string } }).cause;
    expect(cause?.message).toMatch(/UNIQUE constraint failed.*(?:guid|idx_blacklist_guid_unique)/);

    const rows = await allRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ infoHash: 'h1', guid: 'g1', title: 'First', reason: 'spam' });
    expect(rows[1]).toMatchObject({ infoHash: 'h2', guid: 'g2', title: 'Second', reason: 'spam' });
  });

  it('omitted optional fields normalize to null/permanent on conflict (no stale leak)', async () => {
    const settingsService = createMockSettingsService();
    const svcWithSettings = new BlacklistService(db, inject(log), settingsService);

    // Seed a book so the bookId FK in the first call is valid
    const [seeded] = await db.insert(books).values({ title: 'Seed Book' }).returning();

    await svcWithSettings.create({
      infoHash: 'abc',
      title: 'A',
      bookId: seeded.id,
      note: 'first',
      blacklistType: 'temporary',
      reason: 'spam',
    });
    // Second call omits bookId, note, blacklistType, guid — should clear them
    await svcWithSettings.create({ infoHash: 'abc', title: 'A2', reason: 'spam' });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      infoHash: 'abc',
      title: 'A2',
      bookId: null,
      note: null,
      blacklistType: 'permanent',
      expiresAt: null,
      guid: null,
    });
  });

  it('TTL resets to null on conflict when blacklistType flips to permanent', async () => {
    const settingsService = createMockSettingsService();
    const svcWithSettings = new BlacklistService(db, inject(log), settingsService);

    await svcWithSettings.create({
      infoHash: 'abc',
      title: 'A',
      reason: 'spam',
      blacklistType: 'temporary',
    });

    let rows = await allRows();
    expect(rows[0].expiresAt).toBeInstanceOf(Date);

    await svcWithSettings.create({
      infoHash: 'abc',
      title: 'A',
      reason: 'spam',
      blacklistType: 'permanent',
    });

    rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt).toBeNull();
    expect(rows[0].blacklistType).toBe('permanent');
  });

  it('rejects when neither identifier is provided', async () => {
    await expect(
      service.create({ title: 'X', reason: 'spam' }),
    ).rejects.toThrow('Blacklist entry requires at least one identifier');
  });
});
