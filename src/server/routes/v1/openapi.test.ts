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
import type { Db } from '@db/index.js';
import { createMockDb, inject } from '../../__tests__/helpers.js';
import { registerV1OpenApi, V1_DOCS_BASE_PATH } from './openapi.js';
import { v1BooksRoutes } from './books.js';
import { v1AuthorsRoutes } from './authors.js';
import { v1NarratorsRoutes } from './narrators.js';
import { v1SeriesRoutes } from './series.js';
import { v1DownloadsRoutes } from './downloads.js';
import { v1ActionsRoutes } from './actions.js';
import { v1MetadataRoutes } from './metadata.js';
import { v1SystemRoutes } from './system.js';
import { v1CapabilitiesRoutes } from './capabilities.js';
import { v1CompanionEbookRoutes } from './companion-ebook.js';

// Keep authBypass off so the auth plugin exercises docs exemptions.
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

// Spec generation registers handlers but never invokes these service stubs.
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
const settingsService = { get: vi.fn().mockResolvedValue({ enabled: false }) };
// A dedicated capabilities stub makes public-docs setting reads observable in isolation.
const capabilitiesSettingsService = { get: vi.fn().mockResolvedValue({ enabled: true }) };

// Swagger must register before the prefixed routes so its onRoute hook captures them.
// Internal and compatibility decoys make spec exclusion falsifiable.
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
      settingsService: settingsService as never,
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
      blacklistService: {} as never,
      settingsService: {} as never,
      indexerService: {} as never,
    }, db);
    await v1MetadataRoutes(scoped, {
      metadataService: metadataService as never,
      bookService: bookService as never,
      settingsService: settingsService as never,
    });
    await v1SystemRoutes(scoped);
    await v1CapabilitiesRoutes(scoped, { settingsService: capabilitiesSettingsService as never });
    // The completeness guard below fails if this hand-built list drifts from routeRegistry.
    await v1CompanionEbookRoutes(scoped, {
      bookService: bookService as never,
      settingsService: settingsService as never,
      reconciler: { reconcileBook: vi.fn() },
    }, db);
    // These non-v1 decoys must stay absent from the public spec.
    scoped.get('/api/books', async () => ({ ok: true }));
    scoped.get('/api/v1/system/status', async () => ({ ok: true }));
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
// Singletons lack detail/list envelopes, so exclude them from generic read assertions.
const SINGLETON_PATHS = ['/api/v1/system', '/api/v1/capabilities'];
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
    for (const p of [...READ_PATHS, ...ACTION_PATHS, ...SINGLETON_PATHS]) {
      expect(spec.paths).toHaveProperty([p]);
    }
  });

  it('excludes internal /api/* and Prowlarr-compat routes from the public spec', () => {
    expect(spec.paths).not.toHaveProperty(['/api/books']);
    expect(spec.paths).not.toHaveProperty(['/api/v1/system/status']);
    for (const key of Object.keys(spec.paths)) {
      expect(key.startsWith('/api/v1/')).toBe(true);
    }
  });

  it('reflects the list-envelope { data, total } shape derived from the Zod schema', () => {
    const schema = spec.paths['/api/v1/books'].get.responses['200'].content['application/json'].schema;
    expect(schema.properties).toHaveProperty('data');
    expect(schema.properties).toHaveProperty('total');
    expect(schema.properties.data.type).toBe('array');
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

    // #2527 added the single-flight 409 and the deadline 504 to discovery.
    const search = spec.paths['/api/v1/books/{publicId}/search'].post.responses;
    expect(Object.keys(search)).toEqual(expect.arrayContaining(['200', '400', '404', '409', '504']));
  });

  it('documents the search 409 with a description naming SEARCH_IN_PROGRESS and what holds the slot (#2527)', () => {
    const search = spec.paths['/api/v1/books/{publicId}/search'].post.responses;
    const description: string = search['409'].description;
    expect(description).toBeTruthy();
    expect(description).toContain('SEARCH_IN_PROGRESS');
    expect(description).toMatch(/scheduled|import.list|retry/i);
  });

  it('documents the grab 409 with a description enumerating both conflict codes and their meaning (#1861)', () => {
    const grab = spec.paths['/api/v1/books/{publicId}/grab'].post.responses;
    const description: string = grab['409'].description;
    expect(description).toBeTruthy();
    expect(description).toContain('ACTIVE_DOWNLOAD_EXISTS');
    expect(description).toContain('PIPELINE_ACTIVE');
    expect(description).toMatch(/import pipeline|quality gate/i);
  });

  it('documents POST /api/v1/books with a request body and its declared response codes (#1520)', () => {
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
    expect(spec.paths).toHaveProperty(['/api/v1/metadata/search']);
    const responses = spec.paths['/api/v1/metadata/search'].get.responses;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '400']));
    const schema = responses['200'].content['application/json'].schema;
    expect(schema.properties).toHaveProperty('data');
    expect(schema.properties).toHaveProperty('total');
    expect(schema.properties.data.type).toBe('array');
    const item = schema.properties.data.items;
    expect(item.properties).toHaveProperty('library');
    // library is optional but non-nullable.
    expect(item.required ?? []).not.toContain('library');
    const library = item.properties.library;
    expect(library.type).toBe('object');
    expect(library.nullable).toBeUndefined();
    expect(library.anyOf).toBeUndefined();
    expect(library.oneOf).toBeUndefined();
  });

  describe('GET /api/v1/capabilities (#1961)', () => {
    function capabilitySchema() {
      return spec.paths['/api/v1/capabilities'].get.responses['200'].content['application/json'].schema;
    }

    it('documents the endpoint at the RELATIVE path key with a 200 exposing companionEpub.enabled as a boolean', () => {
      expect(spec.paths).toHaveProperty(['/api/v1/capabilities']);
      expect(spec.paths['/api/v1/capabilities'].get.responses).toHaveProperty(['200']);
      const enabled = capabilitySchema().properties.companionEpub.properties.enabled;
      expect(enabled.type).toBe('boolean');
    });

    // Reusing companionEpubSettingsSchema would leak its default(false) into public docs.
    it.each(['default', 'example', 'examples', 'const', 'enum'])(
      'never publishes the enabled VALUE — the emitted schema carries no %s',
      (key) => {
        expect(capabilitySchema().properties.companionEpub.properties.enabled).not.toHaveProperty([key]);
      },
    );

    it('generates the spec without ever reading the companionEpub setting', () => {
      expect(capabilitiesSettingsService.get).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/books/{publicId}/companion-epub (#1975)', () => {
    it('documents the endpoint at the RELATIVE path key with a get operation', () => {
      expect(spec.paths).toHaveProperty(['/api/v1/books/{publicId}/companion-epub']);
      expect(spec.paths['/api/v1/books/{publicId}/companion-epub'].get).toBeTruthy();
    });

    it('documents the publicId path parameter', () => {
      const params = spec.paths['/api/v1/books/{publicId}/companion-epub'].get.parameters ?? [];
      expect(params.map((p: { name: string }) => p.name)).toContain('publicId');
    });
  });

  describe('companionEbook on both producers (#1961)', () => {
    function bookItem() {
      return spec.paths['/api/v1/books'].get.responses['200'].content['application/json'].schema
        .properties.data.items;
    }
    function libraryObject() {
      return spec.paths['/api/v1/metadata/search'].get.responses['200'].content['application/json'].schema
        .properties.data.items.properties.library;
    }

    it('documents it as a REQUIRED nullable member of the book item', () => {
      const item = bookItem();
      expect(item.properties).toHaveProperty('companionEbook');
      expect(item.required).toContain('companionEbook');
      expect(item.properties.companionEbook.nullable).toBe(true);
    });

    it('documents it as a REQUIRED nullable member INSIDE the metadata-search library annotation', () => {
      const library = libraryObject();
      expect(library.properties).toHaveProperty('companionEbook');
      expect(library.required).toContain('companionEbook');
      expect(library.properties.companionEbook.nullable).toBe(true);
    });

    it('keeps library itself optional even though its members are required', () => {
      const item = spec.paths['/api/v1/metadata/search'].get.responses['200'].content['application/json'].schema
        .properties.data.items;
      expect(item.required ?? []).not.toContain('library');
    });

    it.each([
      ['book item', () => bookItem().properties.companionEbook],
      ['library annotation', () => libraryObject().properties.companionEbook],
    ])('describes the same { format: epub, sizeBytes } shape on the %s', (_label, get) => {
      const schema = get() as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
      expect(schema.properties.format!.enum).toEqual(['epub']);
      expect(schema.properties.sizeBytes!.type).toBe('number');
      expect(schema.required.sort()).toEqual(['format', 'sizeBytes']);
    });
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
    // OpenAPI keeps the prefix in servers[].url and path keys relative to it.
    expect(spec.servers).toEqual([{ url: URL_BASE }]);
    expect(spec.paths).toHaveProperty(['/api/v1/books']);
    expect(spec.paths).toHaveProperty(['/api/v1/capabilities']);
    expect(spec.paths).not.toHaveProperty([`${URL_BASE}/api/v1/capabilities`]);
  });

  it('does NOT duplicate URL_BASE — no path key carries the prefix, and the composed URL has it exactly once', () => {
    // stripBasePath keeps servers.url out of every path key.
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

// Set equality catches drift in either direction between the hand-built spec and production registry.
// The non-empty floor prevents incompatible stubs from making the guard pass vacuously.
describe('spec completeness against the production routeRegistry (#1979)', () => {
  it('documents exactly the native-v1 surface the registry mounts', async () => {
    const { routeRegistry } = await import('../index.js');

    const collector = Fastify({ logger: false, routerOptions: { maxParamLength: 2048 } }).withTypeProvider<ZodTypeProvider>();
    collector.setValidatorCompiler(validatorCompiler);
    collector.setSerializerCompiler(serializerCompiler);

    // Normalize Fastify params and reuse production exclusions so this guard matches the transform.
    const { isProwlarrCompatPath } = await import('../prowlarr-compat.js');
    const collected = new Set<string>();
    collector.addHook('onRoute', (route) => {
      if (!(route.url === '/api/v1' || route.url.startsWith('/api/v1/'))) return;
      if (isProwlarrCompatPath(route.url, '')) return;
      if (route.url.startsWith('/api/v1/docs')) return;
      const specPath = route.url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) {
        if (m === 'HEAD' || m === 'OPTIONS') continue;
        collected.add(`${m.toLowerCase()} ${specPath}`);
      }
    });

    // Factories only close over dependencies here; the proxy supplies stable, never-invoked stubs.
    const stubs = new Map<string, object>();
    const services = new Proxy({}, {
      get(_t, prop: string) {
        if (!stubs.has(prop)) stubs.set(prop, { __service: prop });
        return stubs.get(prop);
      },
    }) as never;
    const db = inject<Db>(createMockDb());

    // Non-v1 factories may reject these stubs; a v1 failure still creates a set inequality below.
    for (const factory of routeRegistry) {
      try {
        await factory(collector as never, services, db);
      } catch {
        /* non-v1 factory incompatible with the stub environment */
      }
    }
    await collector.close();

    const app = await buildApp('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spec = (app as any).swagger();
    await app.close();

    const documented = new Set<string>();
    for (const [pathKey, item] of Object.entries<Record<string, unknown>>(spec.paths)) {
      for (const method of Object.keys(item)) documented.add(`${method} ${pathKey}`);
    }

    expect(collected.size).toBeGreaterThan(0);
    expect([...documented].sort()).toEqual([...collected].sort());
  });
});
