import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { computeInfoHash } from './torrent.js';

/**
 * Fake qBittorrent WebUI server. Implements the subset of endpoints
 * `src/core/download-clients/qbittorrent.ts` actually calls:
 *
 *   POST /api/v2/auth/login       — form-urlencoded; returns Set-Cookie: SID=...
 *   POST /api/v2/torrents/add     — multipart w/ `torrents` blob (savepath optional)
 *   GET  /api/v2/torrents/info    — JSON array of torrents, filter by ?hashes=
 *   GET  /api/v2/app/version      — plain-text version string (for `test()`)
 *
 * Completion semantics (CRITICAL — matches `mapState` in qbittorrent.ts):
 *   - `state: 'uploading'` + `content_path` INSIDE `save_path` → maps to 'seeding' (completed in monitor's vocabulary)
 *   - If `content_path` is outside `save_path`, `mapState` downgrades to 'downloading'
 *
 * Control endpoint (test-use only):
 *   POST /__control/complete  — { hash } flips state, stages the fixture, sets content_path
 *   POST /__control/reset     — clears all torrents
 */

const SID = 'e2e-test-sid';

interface FakeTorrent {
  hash: string;
  name: string;
  state: 'downloading' | 'uploading';
  progress: number;
  total_size: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  num_seeds: number;
  num_leechs: number;
  eta: number;
  save_path: string;
  content_path?: string;
  added_on: number;
  completion_on: number;
}

export interface CreateQBitFakeOptions {
  port?: number;
  username?: string;
  password?: string;
  /** Default save path the fake uses when `POST /torrents/add` omits `savepath`. */
  downloadsPath: string;
  /** Absolute path to the audio fixture copied in during completion. */
  fixturePath: string;
  /** Version string returned by `/api/v2/app/version`. Defaults to `4.6.0`. */
  version?: string;
  /**
   * Artificial latency (ms) injected into `POST /api/v2/torrents/add` before it
   * returns `Ok.`. Defaults to 0 for unit tests. E2E specs should set a small
   * non-zero value so the grab-button pending state becomes observable —
   * otherwise the fake resolves the mutation before React can re-render.
   */
  addLatencyMs?: number;
}

export interface QBitFakeHandle {
  server: FastifyInstance;
  url: string;
  close: () => Promise<void>;
  /** Return all torrents the fake currently tracks. Test utility. */
  listTorrents: () => FakeTorrent[];
  /** Programmatically complete a torrent (same effect as POST /__control/complete). */
  completeTorrent: (hash: string) => void;
  /** Wipe all torrent state. */
  reset: () => void;
}

// Sanitize the torrent name for use as a directory — mirrors qBit's relaxed behavior
// (it accepts most characters). For our fake we just replace path separators.
function torrentNameFromBytes(bytes: Buffer): string {
  const marker = Buffer.from('4:name');
  const idx = bytes.indexOf(marker);
  if (idx === -1) return 'unknown';

  let pos = idx + marker.length;
  const colonIdx = bytes.indexOf(0x3A, pos); // ':'
  if (colonIdx === -1) return 'unknown';

  const len = parseInt(bytes.subarray(pos, colonIdx).toString(), 10);
  if (!Number.isFinite(len) || len <= 0) return 'unknown';

  return bytes.subarray(colonIdx + 1, colonIdx + 1 + len).toString();
}

export async function createQBitFake(options: CreateQBitFakeOptions): Promise<QBitFakeHandle> {
  const port = options.port ?? 4200;
  const username = options.username ?? 'admin';
  const password = options.password ?? 'adminadmin';
  const version = options.version ?? '4.6.0';
  const addLatencyMs = options.addLatencyMs ?? 0;
  const downloadsPath = resolve(options.downloadsPath);
  const fixturePath = resolve(options.fixturePath);

  if (!existsSync(fixturePath)) {
    throw new Error(`fake qBit: fixture not found at ${fixturePath}`);
  }

  const torrents = new Map<string, FakeTorrent>();

  const server = Fastify({ logger: process.env.E2E_FAKE_LOGS === '1' });
  // Fastify 5 has no built-in form-urlencoded parser. The login endpoint uses
  // that content type, so register a raw pass-through and parse in-handler.
  server.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  await server.register(multipart);

  // ── Auth gate ────────────────────────────────────────────────────────────
  server.addHook('preHandler', async (request, reply) => {
    if (
      request.url.startsWith('/__control/') ||
      request.url.startsWith('/api/v2/auth/login') ||
      request.url.startsWith('/api/v2/app/version') // real qBit also allows unauth version
    ) {
      return;
    }

    const cookieHeader = request.headers.cookie ?? '';
    if (!cookieHeader.includes(`SID=${SID}`)) {
      return reply.status(403).send('Forbidden');
    }
  });

  // ── POST /api/v2/auth/login ──────────────────────────────────────────────
  server.post('/api/v2/auth/login', async (request, reply) => {
    const params = new URLSearchParams(typeof request.body === 'string' ? request.body : '');
    const u = params.get('username');
    const p = params.get('password');

    if (u !== username || p !== password) {
      return reply.status(200).type('text/plain').send('Fails.');
    }

    return reply
      .status(200)
      .header('set-cookie', `SID=${SID}; HttpOnly`)
      .type('text/plain')
      .send('Ok.');
  });

  // ── GET /api/v2/app/version ──────────────────────────────────────────────
  server.get('/api/v2/app/version', async () => version);

  // ── POST /api/v2/torrents/add (multipart) ────────────────────────────────
  server.post('/api/v2/torrents/add', async (request, reply) => {
    let torrentBytes: Buffer | undefined;
    let savePath: string | undefined;

    for await (const part of request.parts()) {
      if (part.type === 'file' && part.fieldname === 'torrents') {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(chunk as Buffer);
        torrentBytes = Buffer.concat(chunks);
      } else if (part.type === 'field' && part.fieldname === 'savepath') {
        savePath = String(part.value);
      }
      // Other fields (category, paused, etc.) are accepted and ignored.
    }

    if (!torrentBytes) {
      return reply.status(400).send({ error: 'missing torrents file part' });
    }

    const hash = computeInfoHash(torrentBytes);
    if (!hash) {
      return reply.status(400).send({ error: 'could not extract info_hash from torrent' });
    }

    const name = torrentNameFromBytes(torrentBytes);
    const effectiveSavePath = savePath ?? downloadsPath;

    torrents.set(hash, {
      hash,
      name,
      state: 'downloading',
      progress: 0,
      total_size: 0,
      downloaded: 0,
      uploaded: 0,
      ratio: 0,
      num_seeds: 0,
      num_leechs: 0,
      eta: 0,
      save_path: effectiveSavePath,
      added_on: Math.floor(Date.now() / 1000),
      completion_on: 0,
    });

    // Optional artificial latency so spec-side tests can observe the grab
    // button's pending state before the mutation resolves. A real qBit add is
    // not instant either — this just makes the fake closer to reality.
    if (addLatencyMs > 0) {
      await new Promise((res) => setTimeout(res, addLatencyMs));
    }

    // Real qBit returns plain text "Ok." on success.
    return reply.status(200).type('text/plain').send('Ok.');
  });

  // ── GET /api/v2/torrents/info ────────────────────────────────────────────
  server.get('/api/v2/torrents/info', async (request) => {
    const hashesParam = (request.query as { hashes?: string }).hashes;
    if (!hashesParam) return Array.from(torrents.values());

    const wanted = new Set(hashesParam.toLowerCase().split('|').filter(Boolean));
    return Array.from(torrents.values()).filter((t) => wanted.has(t.hash.toLowerCase()));
  });

  // ── POST /__control/complete ─────────────────────────────────────────────
  // Stages the fixture at `<save_path>/<name>/silent.m4b`, flips state to
  // 'uploading', sets content_path inside save_path (required by mapState).
  function completeTorrentInternal(hash: string): FakeTorrent | null {
    const t = torrents.get(hash);
    if (!t) return null;

    const contentDir = join(t.save_path, t.name);
    mkdirSync(contentDir, { recursive: true });
    const stagedFile = join(contentDir, 'silent.m4b');
    copyFileSync(fixturePath, stagedFile);

    t.state = 'uploading';
    t.progress = 1;
    t.content_path = contentDir;
    t.completion_on = Math.floor(Date.now() / 1000);

    return t;
  }

  server.post('/__control/complete', async (request, reply) => {
    const body = request.body as { hash?: string };
    if (!body?.hash) {
      return reply.status(400).send({ error: 'body requires { hash: string }' });
    }
    const result = completeTorrentInternal(body.hash);
    if (!result) {
      return reply.status(404).send({ error: `unknown hash: ${body.hash}` });
    }
    return { ok: true, torrent: result };
  });

  // Convenience for single-torrent spec flows that don't want to track hashes —
  // completes the most-recently-added torrent.
  server.post('/__control/complete-latest', async (_request, reply) => {
    const entries = Array.from(torrents.values());
    if (entries.length === 0) {
      return reply.status(404).send({ error: 'no torrents have been added' });
    }
    const latest = entries[entries.length - 1]!;
    const result = completeTorrentInternal(latest.hash);
    return { ok: true, torrent: result };
  });

  server.post('/__control/reset', async () => {
    torrents.clear();
    return { ok: true };
  });

  await server.listen({ port, host: '127.0.0.1' });

  return {
    server,
    url: `http://localhost:${port}`,
    close: async () => {
      await server.close();
    },
    listTorrents: () => Array.from(torrents.values()),
    completeTorrent: (hash) => {
      completeTorrentInternal(hash);
    },
    reset: () => {
      torrents.clear();
    },
  };
}
