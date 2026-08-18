import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  access: vi.fn(),
  constants: { R_OK: 4 },
}));

// Import after mock registration.
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
    mockAccess.mockResolvedValue(undefined);
  });

  describe('GET /api/filesystem/browse', () => {
    /**
     * #2435 AC20 — an opt-in `files` array, added without touching the legacy shape.
     */
    describe('opt-in audio file listing', () => {
      const MIXED = () => [
        makeDirent('book.m4b', false),
        makeDirent('notes.txt', false),
        makeDirent('.hidden.m4b', false),
        makeDirent('Disc 1', true),
        makeDirent('.hidden-dir', true),
      ];

      it('returns exactly { dirs, parent } with no opt-in parameter', async () => {
        mockReaddir.mockResolvedValue(MIXED());

        const res = await app.inject({ method: 'GET', url: '/api/filesystem/browse?path=/media' });

        const body = res.json();
        expect(res.statusCode).toBe(200);
        // Key absence, not undefined-ness: PathInput and the settings browser must be provably
        // unaffected, and `not.objectContaining` passes on a present-but-undefined key.
        expect(body).not.toHaveProperty('files');
        expect(Object.keys(body).sort()).toEqual(['dirs', 'parent']);
      });

      it('adds supported, non-hidden, readable audio files when opted in', async () => {
        mockReaddir.mockResolvedValue(MIXED());

        const res = await app.inject({ method: 'GET', url: '/api/filesystem/browse?path=/media&include=audio' });

        const body = res.json();
        expect(res.statusCode).toBe(200);
        expect(body.files).toEqual(['book.m4b']);
        expect(body.dirs).toContain('Disc 1');
      });

      // Proves this AC added a capability rather than silently narrowing an existing one.
      it('leaves the legacy dirs filtering untouched in BOTH modes', async () => {
        mockReaddir.mockResolvedValue(MIXED());

        const legacy = await app.inject({ method: 'GET', url: '/api/filesystem/browse?path=/media' });
        const optedIn = await app.inject({ method: 'GET', url: '/api/filesystem/browse?path=/media&include=audio' });

        // A readable `.hidden-dir` is returned today; hidden-name filtering applies to `files` only.
        expect(legacy.json().dirs).toEqual(optedIn.json().dirs);
        expect(legacy.json().dirs).toContain('.hidden-dir');
      });

      it('skips an unreadable file silently rather than failing the listing', async () => {
        mockReaddir.mockResolvedValue([makeDirent('ok.m4b', false), makeDirent('locked.m4b', false)]);
        mockAccess.mockImplementation((p: string) =>
          String(p).includes('locked.m4b') ? Promise.reject(new Error('EACCES')) : Promise.resolve(undefined));

        const res = await app.inject({ method: 'GET', url: '/api/filesystem/browse?path=/media&include=audio' });

        expect(res.statusCode).toBe(200);
        expect(res.json().files).toEqual(['ok.m4b']);
      });

      it('400s an unrecognized include value instead of falling back to the legacy shape', async () => {
        mockReaddir.mockResolvedValue(MIXED());

        const res = await app.inject({ method: 'GET', url: '/api/filesystem/browse?path=/media&include=video' });

        expect(res.statusCode).toBe(400);
      });
    });

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
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        .mockResolvedValueOnce(undefined);

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
