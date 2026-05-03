import { describe, it, expect, beforeEach } from 'vitest';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { createMockDbRemotePathMapping } from '../__tests__/factories.js';
import { RemotePathMappingService } from './remote-path-mapping.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';

const mockMapping = createMockDbRemotePathMapping();

describe('RemotePathMappingService', () => {
  let db: ReturnType<typeof createMockDb>;
  let service: RemotePathMappingService;

  beforeEach(() => {
    db = createMockDb();
    service = new RemotePathMappingService(inject<Db>(db), inject<FastifyBaseLogger>(createMockLogger()));
  });

  describe('getAll', () => {
    it('returns all mappings', async () => {
      db.select.mockReturnValue(mockDbChain([mockMapping]));

      const result = await service.getAll();
      expect(result).toHaveLength(1);
      expect(result[0]!.remotePath).toBe('/downloads/complete/');
    });
  });

  describe('getById', () => {
    it('returns mapping when found', async () => {
      db.select.mockReturnValue(mockDbChain([mockMapping]));

      const result = await service.getById(1);
      expect(result).not.toBeNull();
      expect(result!.remotePath).toBe('/downloads/complete/');
    });

    it('returns null when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.getById(999);
      expect(result).toBeNull();
    });
  });

  describe('getByClientId', () => {
    it('returns only mappings for the specified client', async () => {
      const mapping1 = createMockDbRemotePathMapping({ id: 1, downloadClientId: 1 });
      db.select.mockReturnValue(mockDbChain([mapping1]));

      const result = await service.getByClientId(1);
      expect(result).toHaveLength(1);
      expect(result[0]!.downloadClientId).toBe(1);
    });
  });

  describe('create', () => {
    it('inserts and returns new mapping', async () => {
      db.insert.mockReturnValue(mockDbChain([mockMapping]));

      const result = await service.create({
        downloadClientId: 1,
        remotePath: '/downloads/complete/',
        localPath: 'C:\\downloads\\',
      });

      expect(result.remotePath).toBe('/downloads/complete/');
    });
  });

  describe('update', () => {
    it('updates and returns mapping', async () => {
      const updated = { ...mockMapping, remotePath: '/new/path/' };
      db.update.mockReturnValue(mockDbChain([updated]));

      const result = await service.update(1, { remotePath: '/new/path/' });
      expect(result).not.toBeNull();
      expect(result!.remotePath).toBe('/new/path/');
    });

    it('returns null when not found', async () => {
      db.update.mockReturnValue(mockDbChain([]));

      const result = await service.update(999, { remotePath: '/new/path/' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('returns true when mapping exists', async () => {
      db.select.mockReturnValue(mockDbChain([mockMapping]));
      db.delete.mockReturnValue(mockDbChain());

      const result = await service.delete(1);
      expect(result).toBe(true);
    });

    it('returns false when not found', async () => {
      db.select.mockReturnValue(mockDbChain([]));

      const result = await service.delete(999);
      expect(result).toBe(false);
    });
  });
});
