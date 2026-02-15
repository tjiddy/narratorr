import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BlacklistService } from './blacklist.service.js';
import { createMockDb, createMockLogger, mockDbChain } from '../__tests__/helpers.js';

const mockEntry = {
  id: 1,
  bookId: null,
  infoHash: 'abc123def456',
  title: 'Bad Release [Unabridged]',
  reason: 'wrong_content',
  note: 'Not the right book',
  blacklistedAt: new Date(),
};

const mockEntry2 = {
  id: 2,
  bookId: 5,
  infoHash: 'xyz789',
  title: 'Spam Release',
  reason: 'spam',
  note: null,
  blacklistedAt: new Date(),
};

describe('BlacklistService', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;
  let service: BlacklistService;

  beforeEach(() => {
    db = createMockDb();
    log = createMockLogger();
    service = new BlacklistService(db as never, log as never);
  });

  describe('getAll', () => {
    it('returns all blacklist entries', async () => {
      db.select.mockReturnValue(mockDbChain([mockEntry, mockEntry2]));
      const result = await service.getAll();
      expect(result).toHaveLength(2);
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
  });
});
