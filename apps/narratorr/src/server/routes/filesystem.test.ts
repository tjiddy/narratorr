import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Import after mock registration so the route picks up the mock
import { readdir, access } from 'node:fs/promises';

const mockReaddir = readdir as Mock;
const mockAccess = access as Mock;

function makeDirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

describe('filesystem routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    mockReaddir.mockReset();
    mockAccess.mockReset();
    mockAccess.mockResolvedValue(undefined); // default: all dirs readable
  });

  describe('GET /api/filesystem/browse', () => {
    it('returns directory listing for a valid path', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('audiobooks', true),
        makeDirent('music', true),
        makeDirent('readme.txt', false),
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/media',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.dirs).toEqual(['audiobooks', 'music']);
      expect(body.parent).toBeTruthy();
    });

    it('returns parent: null for root path', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('home', true),
        makeDirent('etc', true),
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.parent).toBeNull();
    });

    it('returns correct parent for nested path', async () => {
      mockReaddir.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/media/audiobooks',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.parent).toMatch(/media$/);
    });

    it('sorts directories alphabetically case-insensitive', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('Zebra', true),
        makeDirent('alpha', true),
        makeDirent('Beta', true),
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/media',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.dirs).toEqual(['alpha', 'Beta', 'Zebra']);
    });

    it('returns 400 for nonexistent path', async () => {
      mockReaddir.mockRejectedValue(
        Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/nonexistent',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('ENOENT');
    });

    it('returns 400 when target path is unreadable (EACCES)', async () => {
      mockReaddir.mockRejectedValue(
        Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/root',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toContain('EACCES');
    });

    it('defaults to / when no path param provided', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('home', true),
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.dirs).toEqual(['home']);
    });

    it('skips unreadable child directories without failing', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('readable', true),
        makeDirent('forbidden', true),
        makeDirent('also-readable', true),
      ]);
      mockAccess
        .mockResolvedValueOnce(undefined) // readable: ok
        .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' })) // forbidden: denied
        .mockResolvedValueOnce(undefined); // also-readable: ok

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/media',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.dirs).toEqual(['also-readable', 'readable']);
      expect(body.dirs).not.toContain('forbidden');
    });

    it('filters out files and only returns directories', async () => {
      mockReaddir.mockResolvedValue([
        makeDirent('subdir', true),
        makeDirent('file.txt', false),
        makeDirent('image.png', false),
        makeDirent('another-dir', true),
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?path=/media',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.dirs).toEqual(['another-dir', 'subdir']);
    });
  });
});
