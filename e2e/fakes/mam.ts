import Fastify, { type FastifyInstance } from 'fastify';
import { buildTorrentBytes } from './torrent.js';

/**
 * Fake MyAnonamouse server. Implements the subset of endpoints
 * `src/core/indexers/myanonamouse.ts` actually calls:
 *
 *   GET /tor/js/loadSearchJSONbasic.php   — JSON search
 *   GET /tor/download.php?tid=<id>        — raw .torrent bytes
 *   GET /jsonLoad.php                     — `test()` probe
 *
 * All endpoints require `Cookie: mam_id=<value>`. Unknown/missing cookie → 403
 * with the HTML error shape the real server returns (helpful for producing
 * IndexerAuthError on the app side).
 *
 * Control endpoint (test-use only):
 *   POST /__control/seed   — seeds results for a query term; idempotent
 *   POST /__control/reset  — clears all seed data
 */

export interface MAMFixture {
  /** Positive integer — becomes `id` in the JSON response and `tid` for download. */
  id: number;
  title: string;
  author: string;
  narrator?: string;
  /** MAM lang_code matching `normalizeLanguage` in `src/core/utils/language-codes.ts`. */
  langCode: string;
  /** Human-readable size string, e.g. "881.8 MiB". Narratorr parses this. */
  size: string;
  seeders: number;
  leechers: number;
  isFreeleech?: boolean;
}

export interface CreateMAMFakeOptions {
  /** Port to listen on. Defaults to 4100. */
  port?: number;
  /** Accepted `mam_id` cookie value. Defaults to `test-mam-id`. */
  expectedCookie?: string;
  /** Filename for the torrent payload returned by `/tor/download.php`. Defaults to `silent.m4b`. */
  torrentFileName?: string;
  /** Byte length to advertise in the torrent info dict. Defaults to 4297 (silent.m4b). */
  torrentFileLength?: number;
}

export interface MAMFakeHandle {
  server: FastifyInstance;
  url: string;
  close: () => Promise<void>;
  seedResults: (query: string, fixtures: MAMFixture[]) => void;
  reset: () => void;
}

/** Wraps author/narrator names in MAM's double-encoded JSON shape (`parseDoubleEncodedNames`). */
function encodeNames(names: string): string {
  const inner = JSON.stringify({ '1': names });
  return JSON.stringify(inner);
}

export async function createMAMFake(options: CreateMAMFakeOptions = {}): Promise<MAMFakeHandle> {
  const port = options.port ?? 4100;
  const expectedCookie = options.expectedCookie ?? 'test-mam-id';
  const torrentFileName = options.torrentFileName ?? 'silent.m4b';
  const torrentFileLength = options.torrentFileLength ?? 4297;

  // Pre-compute the torrent bytes once — same payload for every download request.
  const torrentBytes = buildTorrentBytes({ fileName: torrentFileName, fileLength: torrentFileLength });

  // query (lowercased, trimmed) -> fixtures
  const seedStore = new Map<string, MAMFixture[]>();

  const server = Fastify({ logger: process.env.E2E_FAKE_LOGS === '1' });

  // ── Auth middleware ──────────────────────────────────────────────────────
  // The real MAM server returns 403 with an HTML body when `mam_id` is missing.
  // `MyAnonamouseIndexer.fetchWithCookie` checks for HTTP 403 and throws
  // IndexerAuthError with the HTML `<br />\s*(.+)` pattern extracted — mirror it.
  server.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/__control/')) return; // control endpoints skip auth

    const cookieHeader = request.headers.cookie ?? '';
    const match = /mam_id=([^;]+)/.exec(cookieHeader);
    if (!match || match[1] !== expectedCookie) {
      return reply
        .status(403)
        .type('text/html')
        .send('<html><body>Forbidden<br />\n Invalid/missing cookie</body></html>');
    }
  });

  // ── GET /tor/js/loadSearchJSONbasic.php ─────────────────────────────────
  server.get('/tor/js/loadSearchJSONbasic.php', async (request) => {
    const query = String((request.query as { 'tor[text]'?: string })['tor[text]'] ?? '').trim().toLowerCase();

    // Match any seed key that is contained in, or contains, the incoming query.
    // Real release search sends `${title} ${author}` — but tests may seed by
    // title alone. Substring matching keeps the fake forgiving without the
    // caller having to predict Narratorr's exact query shape.
    let fixtures: MAMFixture[] | undefined = seedStore.get(query);
    if (!fixtures) {
      for (const [key, value] of seedStore) {
        if (query.includes(key) || key.includes(query)) {
          fixtures = value;
          break;
        }
      }
    }

    if (process.env.E2E_FAKE_LOGS === '1') {
      request.log.info({ query, seedKeys: Array.from(seedStore.keys()), matched: fixtures?.length ?? 0 }, 'MAM search lookup');
    }

    if (!fixtures || fixtures.length === 0) {
      // MAM's empty-result shape — `MyAnonamouseIndexer.search` treats this as [].
      return { error: 'Nothing returned, out of matches' };
    }

    return {
      data: fixtures.map((f) => ({
        id: f.id,
        title: f.title,
        author_info: encodeNames(f.author),
        narrator_info: f.narrator ? encodeNames(f.narrator) : undefined,
        lang_code: f.langCode,
        size: f.size,
        seeders: f.seeders,
        leechers: f.leechers,
        free: f.isFreeleech ?? false,
        fl_vip: false,
        vip: false,
        personal_freeleech: false,
      })),
    };
  });

  // ── GET /tor/download.php ────────────────────────────────────────────────
  server.get('/tor/download.php', async (request, reply) => {
    const tid = Number((request.query as { tid?: string }).tid);
    if (!Number.isFinite(tid) || tid <= 0) {
      return reply.status(404).send({ error: 'Not found' });
    }

    // All known fixtures map to the same canonical torrent payload — the
    // fake's job is to round-trip through Narratorr's extract/upload/re-hash
    // pipeline, not to serve distinct torrents per tid.
    reply
      .status(200)
      .type('application/x-bittorrent')
      .send(torrentBytes);
  });

  // ── GET /jsonLoad.php ────────────────────────────────────────────────────
  server.get('/jsonLoad.php', async () => {
    return { username: 'e2e-test-user', classname: 'User' };
  });

  // ── Control endpoints ────────────────────────────────────────────────────
  server.post('/__control/seed', async (request, reply) => {
    const body = request.body as { query?: string; fixtures?: MAMFixture[] };
    if (!body?.query || !Array.isArray(body.fixtures)) {
      return reply.status(400).send({ error: 'body requires { query: string, fixtures: MAMFixture[] }' });
    }
    seedStore.set(body.query.trim().toLowerCase(), body.fixtures);
    return { ok: true };
  });

  server.post('/__control/reset', async () => {
    seedStore.clear();
    return { ok: true };
  });

  await server.listen({ port, host: '127.0.0.1' });

  return {
    server,
    url: `http://localhost:${port}`,
    close: async () => {
      await server.close();
    },
    seedResults: (query, fixtures) => {
      seedStore.set(query.trim().toLowerCase(), fixtures);
    },
    reset: () => {
      seedStore.clear();
    },
  };
}
