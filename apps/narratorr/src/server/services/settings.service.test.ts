import { describe, it, expect, beforeEach } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { SettingsService } from './settings.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@narratorr/db';

describe('SettingsService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: SettingsService;

  beforeEach(() => {
    db = createMockDb();
    service = new SettingsService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('get', () => {
    it('returns stored value when found', async () => {
      const stored = { path: '/my-audiobooks', folderFormat: '{author}/{title}' };
      db.select.mockReturnValue(mockDbChain([{ key: 'library', value: stored }]));

      const result = await service.get('library');
      expect(result).toEqual(stored);
    });

    it('returns default value when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('library');
      expect(result).toEqual({ path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });
    });

    it('returns default search settings when not stored', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.get('search');
      expect(result).toEqual({ intervalMinutes: 360, enabled: true });
    });
  });

  describe('getAll', () => {
    it('merges stored values with defaults', async () => {
      const customLibrary = { path: '/custom', folderFormat: '{title}' };
      db.select.mockReturnValue(
        mockDbChain([{ key: 'library', value: customLibrary }]),
      );

      const result = await service.getAll();
      expect(result.library).toEqual(customLibrary);
      // Other sections fall back to defaults
      expect(result.search).toEqual({ intervalMinutes: 360, enabled: true });
      expect(result.import).toEqual({ deleteAfterImport: false, minSeedTime: 60 });
      expect(result.general).toEqual({ logLevel: 'info' });
    });

    it('returns all defaults when nothing stored', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getAll();
      expect(result.library.path).toBe('/audiobooks');
      expect(result.search.enabled).toBe(true);
      expect(result.import.deleteAfterImport).toBe(false);
      expect(result.general.logLevel).toBe('info');
    });
  });

  describe('set', () => {
    it('inserts or upserts the setting', async () => {
      const chain = mockDbChain();
      db.insert.mockReturnValue(chain);

      await service.set('library', { path: '/new', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' });

      expect(db.insert).toHaveBeenCalled();
      expect(chain.values).toHaveBeenCalled();
      expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('sets each provided key and returns all settings', async () => {
      const insertChain = mockDbChain();
      db.insert.mockReturnValue(insertChain);
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.update({
        library: { path: '/updated', folderFormat: '{title}', fileFormat: '{title}' },
      });

      expect(db.insert).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.library).toBeDefined();
    });
  });
});
