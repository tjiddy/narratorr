import Fastify, { type FastifyInstance } from 'fastify';
import { buildTorrentBytes } from './torrent.js';

/** Fake MAM endpoints consumed by the indexer; `/__control/*` mutates fixtures without auth. */

export interface MAMFixture {
  /** Positive torrent ID shared by search and download. */
  id: number;
  title: string;
  author: string;
  narrator?: string;
  langCode: string;
  /** Human-readable size parsed by Narratorr, for example `881.8 MiB`. */
  size: string;
  seeders: number;
  leechers: number;
  isFreeleech?: boolean;
}

export interface CreateMAMFakeOptions {
  port?: number;
  expectedCookie?: string;
  torrentFileName?: string;
  torrentFileLength?: number;
}

export interface BonusBuyOverride {
  success?: boolean;
  error?: string;
}

export interface MAMFakeHandle {
  server: FastifyInstance;
  url: string;
  close: () => Promise<void>;
  seedResults: (query: string, fixtures: MAMFixture[]) => void;
  setWedges: (count: number) => void;
  setBonusBuyResponse: (response: BonusBuyOverride | null) => void;
  bonusBuyCalls: () => Array<{ ts: string; torrentid: string | undefined }>;
  reset: () => void;
}

/** Encodes names twice to match MAM's `author_info`/`narrator_info` wire format. */
function encodeNames(names: string): string {
  const inner = JSON.stringify({ '1': names });
  return JSON.stringify(inner);
}

export async function createMAMFake(options: CreateMAMFakeOptions = {}): Promise<MAMFakeHandle> {
  const port = options.port ?? 4100;
  const expectedCookie = options.expectedCookie ?? 'test-mam-id';
  const torrentFileName = options.torrentFileName ?? 'silent.m4b';
  const torrentFileLength = options.torrentFileLength ?? 4297;

  const torrentBytes = buildTorrentBytes({ fileName: torrentFileName, fileLength: torrentFileLength });

  const seedStore = new Map<string, MAMFixture[]>();
  let wedgeCount = 5;
  let bonusBuyOverride: BonusBuyOverride | null = null;
  const bonusBuyCalls: Array<{ ts: string; torrentid: string | undefined }> = [];

  const server = Fastify({ logger: process.env.E2E_FAKE_LOGS === '1' });

  // Preserve MAM's HTML `<br>` error shape; the indexer extracts its auth detail.
  server.addHook('preHandler', async (request, reply) => {
    if (request.url.startsWith('/__control/')) return;

    const cookieHeader = request.headers.cookie ?? '';
    const match = /mam_id=([^;]+)/.exec(cookieHeader);
    if (!match || match[1] !== expectedCookie) {
      return reply
        .status(403)
        .type('text/html')
        .send('<html><body>Forbidden<br />\n Invalid/missing cookie</body></html>');
    }
  });

  server.get('/tor/js/loadSearchJSONbasic.php', async (request) => {
    const query = String((request.query as { 'tor[text]'?: string })['tor[text]'] ?? '').trim().toLowerCase();

    // App searches use `title author`; containment lets fixtures seed the title alone.
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
      // `MyAnonamouseIndexer.search` normalizes MAM's empty-result error shape to `[]`.
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

  server.get('/tor/download.php', async (request, reply) => {
    const tid = Number((request.query as { tid?: string }).tid);
    if (!Number.isFinite(tid) || tid <= 0) {
      return reply.status(404).send({ error: 'Not found' });
    }

    // One canonical payload is enough to exercise extraction, upload, and re-hashing.
    reply
      .status(200)
      .type('application/x-bittorrent')
      .send(torrentBytes);
  });

  server.get('/jsonLoad.php', async () => {
    return { username: 'e2e-test-user', classname: 'User', wedges: wedgeCount };
  });

  // The override selects branch-specific responses; the default consumes one wedge.
  server.post('/json/bonusBuy.php/:ts', async (request) => {
    const params = request.params as { ts: string };
    const query = request.query as { torrentid?: string };
    bonusBuyCalls.push({ ts: params.ts, torrentid: query.torrentid });
    if (bonusBuyOverride !== null) {
      return { success: bonusBuyOverride.success ?? false, ...(bonusBuyOverride.error !== undefined && { error: bonusBuyOverride.error }) };
    }
    if (wedgeCount <= 0) {
      return { success: false, error: 'Out of wedges' };
    }
    wedgeCount -= 1;
    return { success: true };
  });

  server.post('/__control/seed', async (request, reply) => {
    const body = request.body as { query?: string; fixtures?: MAMFixture[] };
    if (!body?.query || !Array.isArray(body.fixtures)) {
      return reply.status(400).send({ error: 'body requires { query: string, fixtures: MAMFixture[] }' });
    }
    seedStore.set(body.query.trim().toLowerCase(), body.fixtures);
    return { ok: true };
  });

  server.post('/__control/wedges', async (request, reply) => {
    const body = request.body as { count?: unknown };
    const count = body?.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      return reply.status(400).send({ error: 'body requires { count: non-negative integer }' });
    }
    wedgeCount = count;
    return { ok: true, wedges: wedgeCount };
  });

  server.post('/__control/bonus-buy', async (request, reply) => {
    const body = (request.body ?? {}) as { success?: unknown; error?: unknown };
    if (body.success === undefined && body.error === undefined) {
      bonusBuyOverride = null;
      return { ok: true, cleared: true };
    }
    if (body.success !== undefined && typeof body.success !== 'boolean') {
      return reply.status(400).send({ error: 'success must be boolean when provided' });
    }
    if (body.error !== undefined && typeof body.error !== 'string') {
      return reply.status(400).send({ error: 'error must be string when provided' });
    }
    bonusBuyOverride = {
      ...(body.success !== undefined && { success: body.success }),
      ...(body.error !== undefined && { error: body.error }),
    };
    return { ok: true, override: bonusBuyOverride };
  });

  server.post('/__control/reset', async () => {
    seedStore.clear();
    wedgeCount = 5;
    bonusBuyOverride = null;
    bonusBuyCalls.length = 0;
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
    setWedges: (count) => {
      wedgeCount = count;
    },
    setBonusBuyResponse: (response) => {
      bonusBuyOverride = response;
    },
    bonusBuyCalls: () => bonusBuyCalls.slice(),
    reset: () => {
      seedStore.clear();
      wedgeCount = 5;
      bonusBuyOverride = null;
      bonusBuyCalls.length = 0;
    },
  };
}
