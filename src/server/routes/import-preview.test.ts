import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Buffer } from 'node:buffer';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { mintPreviewToken } from '../services/preview-token.js';
import { importPreviewRoute } from './import-preview.js';

// Mock node:path's `relative` with fall-through to actual implementation;
// individual tests can override per-call to simulate Windows cross-drive
// scenarios that Linux CI cannot produce naturally.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, relative: vi.fn(actual.relative) };
});

const TEST_KEY = Buffer.alloc(32, 0xcd);

async function createPreviewTestApp() {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { errorHandlerPlugin } = await import('../plugins/error-handler.js');
  await app.register(errorHandlerPlugin);
  await importPreviewRoute(app);
  await app.ready();
  return app;
}

describe('GET /api/import/preview/:token', () => {
  let app: Awaited<ReturnType<typeof createPreviewTestApp>>;
  let workDir: string;

  beforeAll(async () => {
    _resetKey();
    initializeKey(TEST_KEY);
    app = await createPreviewTestApp();
  });

  afterAll(async () => {
    await app.close();
    _resetKey();
  });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'import-preview-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('streams audio for a valid token (file target, 200)', async () => {
    const file = join(workDir, 'track.mp3');
    await writeFile(file, Buffer.alloc(2048));
    const token = mintPreviewToken(file, workDir);

    const res = await app.inject({ method: 'GET', url: `/api/import/preview/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('streams a 206 with Content-Range for a valid range request', async () => {
    const file = join(workDir, 'track.mp3');
    await writeFile(file, Buffer.alloc(2048));
    const token = mintPreviewToken(file, workDir);

    const res = await app.inject({
      method: 'GET',
      url: `/api/import/preview/${token}`,
      headers: { range: 'bytes=0-127' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-127/2048');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('returns 403 for a tampered token (sig flipped)', async () => {
    const file = join(workDir, 'track.mp3');
    await writeFile(file, Buffer.alloc(64));
    const token = mintPreviewToken(file, workDir);
    const [body, sig] = token.split('.');
    const last = sig!.slice(-1);
    const repl = last === 'A' ? 'B' : 'A';
    const tampered = `${body}.${sig!.slice(0, -1)}${repl}`;

    const res = await app.inject({ method: 'GET', url: `/api/import/preview/${tampered}` });

    expect(res.statusCode).toBe(403);
  });

  it('returns 403 for an expired token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const file = join(workDir, 'track.mp3');
    await writeFile(file, Buffer.alloc(64));
    const token = mintPreviewToken(file, workDir);

    vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
    const res = await app.inject({ method: 'GET', url: `/api/import/preview/${token}` });
    vi.useRealTimers();

    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when path in token no longer exists', async () => {
    const ghost = join(workDir, 'ghost.mp3');
    const token = mintPreviewToken(ghost, workDir);

    const res = await app.inject({ method: 'GET', url: `/api/import/preview/${token}` });

    expect(res.statusCode).toBe(404);
  });

  it('returns 403 when path.relative returns an absolute path (Windows different-drive simulation)', async () => {
    // On Windows, `relative('C:\\root', 'D:\\file')` returns an absolute path
    // (the destination as-is) rather than a `..`-prefixed string. The route
    // guards against this with `isAbsolute(rel)` alongside the `..` check.
    // Linux CI cannot produce this naturally, so we mock `relative` for one call
    // to verify the conditional fires and returns 403 (vs streaming the file).
    const file = join(workDir, 'track.mp3');
    await writeFile(file, Buffer.alloc(64));
    const token = mintPreviewToken(file, workDir);
    vi.mocked(relative).mockReturnValueOnce('D:\\elsewhere\\leak.mp3');

    const res = await app.inject({ method: 'GET', url: `/api/import/preview/${token}` });

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/outside scan root/i);
  });

  it('rejects symlink that resolves outside scanRoot (403)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'import-preview-outside-'));
    try {
      const realFile = join(outside, 'leak.mp3');
      await writeFile(realFile, Buffer.alloc(64));
      const linkPath = join(workDir, 'link.mp3');
      await symlink(realFile, linkPath);

      const token = mintPreviewToken(linkPath, workDir);
      const res = await app.inject({ method: 'GET', url: `/api/import/preview/${token}` });

      expect(res.statusCode).toBe(403);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('streams a directory target by picking the first audio file (recursive)', async () => {
    await mkdir(join(workDir, 'Disc 1'));
    await mkdir(join(workDir, 'Disc 2'));
    await mkdir(join(workDir, 'Disc 10'));
    await writeFile(join(workDir, 'Disc 1', 'track1.mp3'), Buffer.alloc(64));
    await writeFile(join(workDir, 'Disc 2', 'track1.mp3'), Buffer.alloc(64));
    await writeFile(join(workDir, 'Disc 10', 'track1.mp3'), Buffer.alloc(64));

    const token = mintPreviewToken(workDir, workDir);
    const res = await app.inject({ method: 'GET', url: `/api/import/preview/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
  });

  it('returns 403 for tampered path in payload (sig invalid)', async () => {
    const file = join(workDir, 'track.mp3');
    await writeFile(file, Buffer.alloc(64));
    const token = mintPreviewToken(file, workDir);
    const [, sig] = token.split('.');

    const evilPayload = {
      purpose: 'audio-preview',
      path: '/etc/passwd',
      scanRoot: workDir,
      exp: Date.now() + 60_000,
    };
    const evilBody = Buffer.from(JSON.stringify(evilPayload)).toString('base64url');
    const tampered = `${evilBody}.${sig}`;

    const res = await app.inject({ method: 'GET', url: `/api/import/preview/${tampered}` });
    expect(res.statusCode).toBe(403);
  });
});

describe('auth plugin allowlist regression (#1017)', () => {
  it('rejects unauthenticated request to /api/import/preview/* with 401 — route inherits auth gating', async () => {
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      config: { authBypass: false, isDev: true },
    }));

    const FastifyMod = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const { default: authPlugin } = await import('../plugins/auth.js');
    const { validatorCompiler: vc, serializerCompiler: sc } = await import('fastify-type-provider-zod');
    const { importPreviewRoute: routeFn } = await import('./import-preview.js');

    const app = FastifyMod({ logger: false, routerOptions: { maxParamLength: 2048 } });
    app.setValidatorCompiler(vc);
    app.setSerializerCompiler(sc);
    await app.register(cookie);
    const authService = {
      validateApiKey: vi.fn().mockResolvedValue(false),
      getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      hasUser: vi.fn().mockResolvedValue(true),
      verifyCredentials: vi.fn().mockResolvedValue(null),
      getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
      verifySessionCookie: vi.fn().mockReturnValue(null),
      createSessionCookie: vi.fn().mockReturnValue('cookie'),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await app.register(authPlugin, { authService: authService as any });
    await routeFn(app);
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: '/api/import/preview/anytoken' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
      vi.doUnmock('../config.js');
    }
  });
});
