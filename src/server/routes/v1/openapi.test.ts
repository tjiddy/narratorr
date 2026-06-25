import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import cookie from '@fastify/cookie';
import authPlugin from '../../plugins/auth.js';
import type { AuthService } from '../../services/auth.service.js';
import type { Db } from '../../../db/index.js';
import { createMockDb, inject } from '../../__tests__/helpers.js';
import { registerV1OpenApi, V1_DOCS_BASE_PATH } from './openapi.js';
import { v1BooksRoutes } from './books.js';
import { v1AuthorsRoutes } from './authors.js';
import { v1NarratorsRoutes } from './narrators.js';
import { v1SeriesRoutes } from './series.js';
import { v1DownloadsRoutes } from './downloads.js';
import { v1ActionsRoutes } from './actions.js';
import { v1MetadataRoutes } from './metadata.js';

// Mock config so the auth plugin runs with authBypass off (mirrors books.test).
vi.mock('../../config.js', () => ({ config: { authBypass: false, isDev: true } }));

const VALID_KEY = 'valid-key';
const keyHeaders = { 'x-api-key': VALID_KEY };

const authService = {
  validateApiKey: vi.fn().mockResolvedValue(true),
  getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
  hasUser: vi.fn().mockResolvedValue(true),
  verifyCredentials: vi.fn().mockResolvedValue(null),
  getSessionSecret: vi.fn().mockResolvedValue('secret'),
  verifySessionCookie: vi.fn().mockReturnValue(null),
  verifyStreamToken: vi.fn().mockReturnValue(null),
  createSessionCookie: vi.fn().mockReturnValue('cookie'),
} as unknown as AuthService;

/** Minimal service stubs — the spec/docs tests never reach the route handlers. */
const refRead = {
  listAuthors: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getAuthorById: vi.fn().mockResolvedValue(null),
  listNarrators: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getNarratorById: vi.fn().mockResolvedValue(null),
  listSeries: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  getSeriesById: vi.fn().mockResolvedValue(null),
};
const bookService = { getById: vi.fn().mockResolvedValue(null) };
const bookListService = { getAll: vi.fn().mockResolvedValue({ data: [], total: 0 }) };
const downloadService = { getAll: vi.fn().mockResolvedValue({ data: [], total: 0 }), getById: vi.fn() };
const indexerSearchService = { searchAll: vi.fn().mockResolvedValue([]) };
const downloadOrchestrator = { grab: vi.fn() };
const metadataService = { search: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }) };

/**
 * Build a Fastify app mirroring `src/server/index.ts` composition: swagger is
 * registered (before the routes) at the root so its `onRoute` hook captures the
 * v1 routes, which mount inside a `urlBase`-scoped plugin (prefix). Two non-v1
 * decoys (an internal `/api/books` and a Prowlarr-compat `/api/v1/system/status`)
 * are registered to prove the public spec excludes them.
 */
async function buildApp(urlBase = ''): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(authPlugin, { authService, urlBase });
  await registerV1OpenApi(app, urlBase);

  const db = inject<Db>(createMockDb());
  await app.register(async (scoped) => {
    await v1BooksRoutes(scoped, {
      bookService: bookService as never,
      bookListService: bookListService as never,
      metadataService: metadataService as never,
      downloadOrchestrator: downloadOrchestrator as never,
      indexerSearchService: indexerSearchService as never,
      indexerService: {} as never,
      blacklistService: {} as never,
      settingsService: {} as never,
      eventHistory: {} as never,
    }, db);
    await v1AuthorsRoutes(scoped, { referenceReadService: refRead as never }, db);
    await v1NarratorsRoutes(scoped, { referenceReadService: refRead as never }, db);
    await v1SeriesRoutes(scoped, { referenceReadService: refRead as never }, db);
    await v1DownloadsRoutes(scoped, { downloadService: downloadService as never }, db);
    await v1ActionsRoutes(scoped, {
      bookService: bookService as never,
      indexerSearchService: indexerSearchService as never,
      downloadOrchestrator: downloadOrchestrator as never,
      downloadService: downloadService as never,
    }, db);
    await v1MetadataRoutes(scoped, { metadataService: metadataService as never, bookService: bookService as never });
    // Non-v1 decoys (must be ABSENT from the public spec).
    scoped.get('/api/books', async () => ({ ok: true }));
    scoped.get('/api/v1/system/status', async () => ({ ok: true })); // Prowlarr-compat shim
  }, { prefix: urlBase || '/' });

  await app.ready();
  return app;
}

const READ_PATHS = [
  '/api/v1/books',
  '/api/v1/books/{publicId}',
  '/api/v1/authors',
  '/api/v1/authors/{publicId}',
  '/api/v1/narrators',
  '/api/v1/narrators/{publicId}',
  '/api/v1/series',
  '/api/v1/series/{publicId}',
  '/api/v1/downloads',
  '/api/v1/downloads/{publicId}',
];
const ACTION_PATHS = ['/api/v1/books/{publicId}/search', '/api/v1/books/{publicId}/grab'];
const DETAIL_PATHS = READ_PATHS.filter((p) => p.endsWith('{publicId}'));
const LIST_PATHS = READ_PATHS.filter((p) => !p.endsWith('{publicId}'));

describe('v1 OpenAPI spec generation', () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spec: any;

  beforeAll(async () => {
    app = await buildApp('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec = (app as any).swagger();
  });

  afterAll(async () => { await app.close(); });

  it('documents every v1 read endpoint and both action endpoints', () => {
    for (const p of [...READ_PATHS, ...ACTION_PATHS]) {
      expect(spec.paths).toHaveProperty([p]);
    }
  });

  it('excludes internal /api/* and Prowlarr-compat routes from the public spec', () => {
    expect(spec.paths).not.toHaveProperty(['/api/books']);
    expect(spec.paths).not.toHaveProperty(['/api/v1/system/status']);
    // No leaked internal/compat path under any key.
    for (const key of Object.keys(spec.paths)) {
      expect(key.startsWith('/api/v1/')).toBe(true);
    }
  });

  it('reflects the list-envelope { data, total } shape derived from the Zod schema', () => {
    const schema = spec.paths['/api/v1/books'].get.responses['200'].content['application/json'].schema;
    expect(schema.properties).toHaveProperty('data');
    expect(schema.properties).toHaveProperty('total');
    expect(schema.properties.data.type).toBe('array');
    // The item schema carries the bookV1Schema fields.
    const item = schema.properties.data.items;
    expect(item.properties).toHaveProperty('id');
    expect(item.properties).toHaveProperty('title');
    expect(item.properties).toHaveProperty('status');
  });

  it('represents the { error: { code, message } } envelope on declared error responses', () => {
    const schema = spec.paths['/api/v1/books/{publicId}'].get.responses['404'].content['application/json'].schema;
    expect(schema.properties).toHaveProperty('error');
    expect(schema.properties.error.properties).toHaveProperty('code');
    expect(schema.properties.error.properties).toHaveProperty('message');
  });

  it('documents 404 and 400 on every read DETAIL path', () => {
    for (const p of DETAIL_PATHS) {
      const responses = spec.paths[p].get.responses;
      expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400', '404']));
    }
  });

  it('documents 400 on every read LIST path', () => {
    for (const p of LIST_PATHS) {
      const responses = spec.paths[p].get.responses;
      expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400']));
    }
  });

  it('documents the action endpoints with their declared response codes', () => {
    const grab = spec.paths['/api/v1/books/{publicId}/grab'].post.responses;
    expect(Object.keys(grab)).toEqual(expect.arrayContaining(['200', '201', '400', '404', '409']));
  });

  it('documents POST /api/v1/books with a request body and its declared response codes (#1520)', () => {
    // Relative path key, NOT URL_BASE-prefixed (swagger strips the base into
    // servers[].url — learning fastify-swagger-servers-strips-path-prefix).
    expect(spec.paths).toHaveProperty(['/api/v1/books']);
    const post = spec.paths['/api/v1/books'].post;
    expect(post).toBeTruthy();
    expect(post.requestBody).toBeTruthy();
    const bodySchema = post.requestBody.content['application/json'].schema;
    expect(bodySchema.properties).toHaveProperty('asin');
    expect(Object.keys(post.responses)).toEqual(
      expect.arrayContaining(['201', '400', '409', '422', '429', '502']),
    );
  });

  it('documents the metadata search endpoint at the relative path key with 200/400', () => {
    // Relative path key (NOT URL_BASE-prefixed) — @fastify/swagger strips the base
    // into servers[].url (learning fastify-swagger-servers-strips-path-prefix).
    expect(spec.paths).toHaveProperty(['/api/v1/metadata/search']);
    const responses = spec.paths['/api/v1/metadata/search'].get.responses;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400']));
    const schema = responses['200'].content['application/json'].schema;
    expect(schema.properties).toHaveProperty('data');
    expect(schema.properties).toHaveProperty('total');
    expect(schema.properties.data.type).toBe('array');
    // The optional library cross-reference (#1537) is documented on the result item.
    const item = schema.properties.data.items;
    expect(item.properties).toHaveProperty('library');
    // #1539: library is present-or-absent — optional (not in `required`) and
    // non-nullable (a plain object, no null union / nullable flag).
    expect(item.required ?? []).not.toContain('library');
    const library = item.properties.library;
    expect(library.type).toBe('object');
    expect(library.nullable).toBeUndefined();
    expect(library.anyOf).toBeUndefined();
    expect(library.oneOf).toBeUndefined();
  });
});

describe('v1 docs surface — public (no API key)', () => {
  let app: FastifyInstance;

  beforeAll(async () => { app = await buildApp(''); });
  afterAll(async () => { await app.close(); });

  it.each([
    `${V1_DOCS_BASE_PATH}/`,
    `${V1_DOCS_BASE_PATH}/json`,
    `${V1_DOCS_BASE_PATH}/yaml`,
    `${V1_DOCS_BASE_PATH}/static/swagger-ui.css`,
  ])('serves %s without auth (200)', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
  });

  it('serves a valid OpenAPI JSON document at routePrefix/json', async () => {
    const res = await app.inject({ method: 'GET', url: `${V1_DOCS_BASE_PATH}/json` });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBeTruthy();
    expect(doc.paths).toHaveProperty(['/api/v1/books']);
  });

  it('keeps protected v1 DATA routes API-key-gated (exemption is docs-only)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/books' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid API key on a protected v1 data route', async () => {
    (authService.validateApiKey as Mock).mockResolvedValue(true);
    const res = await app.inject({ method: 'GET', url: '/api/v1/books', headers: keyHeaders });
    expect(res.statusCode).toBe(200);
  });
});

describe('v1 docs surface — URL_BASE honored', () => {
  const URL_BASE = '/narratorr';
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spec: any;

  beforeAll(async () => {
    app = await buildApp(URL_BASE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec = (app as any).swagger();
  });
  afterAll(async () => { await app.close(); });

  it('serves the docs subtree under the URL_BASE prefix without auth', async () => {
    for (const sub of ['/', '/json', '/static/swagger-ui.css']) {
      const res = await app.inject({ method: 'GET', url: `${URL_BASE}${V1_DOCS_BASE_PATH}${sub}` });
      expect(res.statusCode).toBe(200);
    }
  });

  it('does NOT serve the docs at the un-prefixed path', async () => {
    const res = await app.inject({ method: 'GET', url: `${V1_DOCS_BASE_PATH}/json` });
    expect(res.statusCode).toBe(404);
  });

  it('reflects URL_BASE in the spec servers base path so the full URL resolves under the prefix', () => {
    // OpenAPI semantics: the prefix lives in `servers[].url`; path keys stay
    // relative to it. Full URL = servers.url + path = `/narratorr/api/v1/books`.
    expect(spec.servers).toEqual([{ url: URL_BASE }]);
    expect(spec.paths).toHaveProperty(['/api/v1/books']);
  });

  it('does NOT duplicate URL_BASE — no path key carries the prefix, and the composed URL has it exactly once', () => {
    // Pins the no-duplication contract: @fastify/swagger's stripBasePath:true
    // strips servers[].url from every path key, so combining servers.url + key
    // yields the prefix exactly once (`/narratorr/api/v1/books`), never twice.
    const serverUrl = spec.servers[0].url;
    expect(serverUrl).toBe(URL_BASE);
    for (const pathKey of Object.keys(spec.paths)) {
      expect(pathKey.startsWith(URL_BASE)).toBe(false);
      const effectiveUrl = `${serverUrl}${pathKey}`;
      expect(effectiveUrl.startsWith(`${URL_BASE}/api/v1/`)).toBe(true);
      expect(effectiveUrl.startsWith(`${URL_BASE}${URL_BASE}`)).toBe(false);
    }
  });
});
