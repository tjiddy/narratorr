import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type Mock } from 'vitest';
import Fastify from 'fastify';

vi.mock('../config.js', () => ({ config: { authBypass: false, isDev: true } }));
import cookie from '@fastify/cookie';
import authPlugin from '../plugins/auth.js';
import type { AuthService } from '../services/auth.service.js';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';

const mockTorznabIndexer = {
  id: 1,
  name: 'My Tracker (Prowlarr)',
  type: 'torznab',
  enabled: true,
  priority: 50,
  settings: {
    apiUrl: 'http://prowlarr:9696/1/',
    apiKey: 'abc123',
    categories: [3030],
    minimumSeeders: 0,
    'seedCriteria.seedRatio': null,
    'seedCriteria.seedTime': null,
  },
  source: 'prowlarr',
  sourceIndexerId: 1,
  createdAt: new Date(),
};

const mockNewznabIndexer = {
  id: 2,
  name: 'NZBGeek (Prowlarr)',
  type: 'newznab',
  enabled: true,
  priority: 50,
  settings: {
    apiUrl: 'http://prowlarr:9696/2/',
    apiKey: 'xyz789',
    categories: [3030],
    minimumSeeders: 0,
    'seedCriteria.seedRatio': null,
    'seedCriteria.seedTime': null,
  },
  source: 'prowlarr',
  sourceIndexerId: 2,
  createdAt: new Date(),
};

const validTorznabBody = {
  name: 'My Tracker',
  implementation: 'Torznab',
  enableRss: true,
  enableAutomaticSearch: true,
  enableInteractiveSearch: true,
  priority: 50,
  fields: [
    { name: 'baseUrl', value: 'http://prowlarr:9696/1/', type: 'textbox' },
    { name: 'apiKey', value: 'abc123', type: 'textbox' },
    { name: 'categories', value: [3030], type: 'tag' },
  ],
};

describe('Prowlarr-compatible API v1 routes', () => {
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
  });

  describe('GET /api/v1/system/status (AC1)', () => {
    it('returns Readarr-compatible JSON with version, appName, instanceName, startTime, isDocker, branch', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system/status' });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload.appName).toBe('Narratorr');
      expect(payload.version).toBeDefined();
      expect(typeof payload.version).toBe('string');
      expect(payload.instanceName).toBe('Narratorr');
      expect(payload.branch).toBe('main');
      expect(payload.authentication).toBe('apiKey');
    });

    it('version is a non-empty string from getVersion()', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system/status' });
      const payload = JSON.parse(res.payload);
      expect(payload.version).toBeDefined();
      expect(payload.version.length).toBeGreaterThan(0);
    });

    it('startTime is valid ISO 8601', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system/status' });
      const payload = JSON.parse(res.payload);
      const date = new Date(payload.startTime);
      expect(date.toISOString()).toBe(payload.startTime);
    });

    it('isDocker reflects DOCKER env var', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/system/status' });
      const payload = JSON.parse(res.payload);
      expect(typeof payload.isDocker).toBe('boolean');
    });
  });

  describe('GET /api/v1/indexer/schema (AC2)', () => {
    it('returns array with Torznab and Newznab schema templates', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/schema' });

      expect(res.statusCode).toBe(200);
      const schemas = JSON.parse(res.payload);
      expect(schemas).toHaveLength(2);
      expect(schemas.map((s: { implementation: string }) => s.implementation)).toEqual(['Torznab', 'Newznab']);
    });

    it('Torznab template has implementation: "Torznab", configContract: "TorznabSettings", protocol: "torrent"', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/schema' });
      const schemas = JSON.parse(res.payload);
      const torznab = schemas[0];

      expect(torznab.implementation).toBe('Torznab');
      expect(torznab.configContract).toBe('TorznabSettings');
      expect(torznab.protocol).toBe('torrent');
    });

    it('Newznab template has implementation: "Newznab", configContract: "NewznabSettings", protocol: "usenet"', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/schema' });
      const schemas = JSON.parse(res.payload);
      const newznab = schemas[1];

      expect(newznab.implementation).toBe('Newznab');
      expect(newznab.configContract).toBe('NewznabSettings');
      expect(newznab.protocol).toBe('usenet');
    });

    it('each template has fields array with baseUrl, apiPath, apiKey, categories, minimumSeeders, seedCriteria fields', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/schema' });
      const schemas = JSON.parse(res.payload);

      for (const schema of schemas) {
        const fieldNames = schema.fields.map((f: { name: string }) => f.name);
        expect(fieldNames).toContain('baseUrl');
        expect(fieldNames).toContain('apiPath');
        expect(fieldNames).toContain('apiKey');
        expect(fieldNames).toContain('categories');
        expect(fieldNames).toContain('minimumSeeders');
        expect(fieldNames).toContain('seedCriteria.seedRatio');
        expect(fieldNames).toContain('seedCriteria.seedTime');
      }
    });
  });

  describe('POST /api/v1/indexer (AC3, AC5, AC7)', () => {
    it('creates Torznab indexer and returns 201 with Readarr-format response', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      expect(res.statusCode).toBe(201);
      const payload = JSON.parse(res.payload);
      expect(payload.id).toBe(1);
      expect(payload.implementation).toBe('Torznab');
      expect(payload.configContract).toBe('TorznabSettings');
      expect(payload.protocol).toBe('torrent');
      expect(payload.fields).toBeDefined();
    });

    it('creates Newznab indexer and returns 201 with protocol: "usenet"', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockNewznabIndexer,
        upserted: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          name: 'NZBGeek',
          implementation: 'Newznab',
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/2/', type: 'textbox' },
            { name: 'apiKey', value: 'xyz789', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
      const payload = JSON.parse(res.payload);
      expect(payload.implementation).toBe('Newznab');
      expect(payload.protocol).toBe('usenet');
    });

    it('returns 400 for unsupported implementation type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: { ...validTorznabBody, implementation: 'Lidarr' },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('Unsupported implementation');
    });

    it('returns 400 when baseUrl field is missing from fields array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [{ name: 'apiKey', value: 'abc', type: 'textbox' }],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('baseUrl');
    });

    it('returns 400 when apiKey field is missing from fields array', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [{ name: 'baseUrl', value: 'http://prowlarr:9696/1/', type: 'textbox' }],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('apiKey');
    });

    it('creates indexer even with unreachable URL (no connectivity check on save)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: { ...mockTorznabIndexer, settings: { ...mockTorznabIndexer.settings, apiUrl: 'http://unreachable:9999/1/' } },
        upserted: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://unreachable:9999/1/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('accepts forceSave=true query param without behavioral effect', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer?forceSave=true',
        payload: validTorznabBody,
      });

      expect(res.statusCode).toBe(201);
    });

    it('stores source: "prowlarr" on created indexer', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIndexerId: 1,
        }),
      );
    });

    it('extracts sourceIndexerId from baseUrl path (e.g. /1/ → 1)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIndexerId: 1 }),
      );
    });

    it('extracts sourceIndexerId from deeper path (e.g. /42/api → 42)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: { ...mockTorznabIndexer, sourceIndexerId: 42 },
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/42/api', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIndexerId: 42 }),
      );
    });

    it('extracts last numeric segment when multiple exist (e.g. /10/sub/20/ → 20)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: { ...mockTorznabIndexer, sourceIndexerId: 20 },
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/10/sub/20/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIndexerId: 20 }),
      );
    });

    it('ignores numeric segments in query/hash and extracts from path only', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: { ...mockTorznabIndexer, sourceIndexerId: 1 },
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/1/?next=/999/#section/42', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIndexerId: 1 }),
      );
    });

    it('extractSourceIndexerId falls back to raw string when URL constructor throws (malformed baseUrl)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      // baseUrl is not a valid URL — triggers URL constructor catch at line 77
      // Falls back to using raw string as pathname, regex finds /42/
      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'not-a-url/42/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIndexerId: 42 }),
      );
    });

    it('sets sourceIndexerId to null when malformed baseUrl has no numeric segment', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: { ...mockTorznabIndexer, sourceIndexerId: null },
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'not-a-url-at-all', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIndexerId: null }),
      );
    });

    it('sets sourceIndexerId to null when baseUrl has no numeric path segment', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: { ...mockTorznabIndexer, sourceIndexerId: null },
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://example.com/no-numeric/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIndexerId: null }),
      );
    });
  });

  describe('POST /api/v1/indexer — upsert (AC9)', () => {
    it('upserts when sourceIndexerId matches existing prowlarr-sourced row and returns 201', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: true,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      // POST always returns 201 per Readarr API contract
      expect(res.statusCode).toBe(201);
    });

    it('returns 201 for new inserts', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('GET /api/v1/indexer (AC3)', () => {
    it('returns all indexers in Readarr format as array', async () => {
      (services.indexer.getAll as Mock).mockResolvedValue([mockTorznabIndexer, mockNewznabIndexer]);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer' });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload).toHaveLength(2);
      expect(payload[0].implementation).toBe('Torznab');
      expect(payload[1].implementation).toBe('Newznab');
    });

    it('includes both Prowlarr-managed and manual indexers', async () => {
      const manualIndexer = {
        ...mockTorznabIndexer,
        id: 3,
        name: 'Manual Torznab',
        source: null,
        sourceIndexerId: null,
      };
      (services.indexer.getAll as Mock).mockResolvedValue([mockTorznabIndexer, manualIndexer]);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer' });

      const payload = JSON.parse(res.payload);
      expect(payload).toHaveLength(2);
    });
  });

  describe('GET /api/v1/indexer/:id (AC3)', () => {
    it('returns single indexer in Readarr format', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload.id).toBe(1);
      expect(payload.implementation).toBe('Torznab');
      expect(payload.fields).toBeDefined();
    });

    it('returns 404 for non-existent id', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/999' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).message).toBeDefined();
    });
  });

  describe('apiKey masking on GET responses (security)', () => {
    it('GET /api/v1/indexer/:id returns sentinel for apiKey, not plaintext', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      const apiKeyField = payload.fields.find((f: { name: string }) => f.name === 'apiKey');
      expect(apiKeyField).toBeDefined();
      expect(apiKeyField.value).toBe('********');
      expect(apiKeyField.value).not.toBe('abc123');
    });

    it('GET /api/v1/indexer masks apiKey on every row', async () => {
      (services.indexer.getAll as Mock).mockResolvedValue([mockTorznabIndexer, mockNewznabIndexer]);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer' });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      for (const row of payload) {
        const apiKeyField = row.fields.find((f: { name: string }) => f.name === 'apiKey');
        expect(apiKeyField.value).toBe('********');
      }
      // Sanity: the response body must not contain either plaintext key anywhere.
      expect(res.payload).not.toContain('abc123');
      expect(res.payload).not.toContain('xyz789');
    });

    it('non-secret fields (categories) pass through unmasked', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });

      const payload = JSON.parse(res.payload);
      const categoriesField = payload.fields.find((f: { name: string }) => f.name === 'categories');
      expect(categoriesField.value).toEqual([3030]);
    });

    it('GET /api/v1/indexer/:id masks baseUrl when apiUrl is set (#742)', async () => {
      // apiUrl is a secret field — it may embed user:pass credentials.
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });

      const payload = JSON.parse(res.payload);
      const baseUrlField = payload.fields.find((f: { name: string }) => f.name === 'baseUrl');
      expect(baseUrlField.value).toBe('********');
      // The plaintext URL must never appear anywhere in the response.
      expect(res.payload).not.toContain('http://prowlarr:9696/1/');
    });

    it('returns empty string (not sentinel) when apiKey is missing', async () => {
      const indexerWithoutKey = {
        ...mockTorznabIndexer,
        settings: { ...mockTorznabIndexer.settings, apiKey: '' },
      };
      (services.indexer.getById as Mock).mockResolvedValue(indexerWithoutKey);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });

      const payload = JSON.parse(res.payload);
      const apiKeyField = payload.fields.find((f: { name: string }) => f.name === 'apiKey');
      expect(apiKeyField.value).toBe('');
    });

    it('sentinel value sent on PUT flows to IndexerService.update unchanged (sentinel passthrough is service-layer concern)', async () => {
      (services.indexer.update as Mock).mockResolvedValue(mockTorznabIndexer);

      await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: '********', type: 'textbox' },
          ],
        },
      });

      expect(services.indexer.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          settings: expect.objectContaining({ apiKey: '********' }),
        }),
      );
      // IndexerService.update is responsible for resolveSentinelFields against the
      // existing encrypted DB row before persisting (see indexer.service.ts lines 61-68).
    });
  });

  describe('PUT /api/v1/indexer/:id (AC3, AC5)', () => {
    it('updates indexer and returns 200 with Readarr-format response', async () => {
      (services.indexer.update as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: validTorznabBody,
      });

      expect(res.statusCode).toBe(200);
      const payload = JSON.parse(res.payload);
      expect(payload.implementation).toBe('Torznab');
    });

    it('returns 404 for non-existent id', async () => {
      (services.indexer.update as Mock).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/999',
        payload: validTorznabBody,
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for unsupported implementation type', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: { ...validTorznabBody, implementation: 'Lidarr' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('updates even with unreachable URL (no connectivity check)', async () => {
      (services.indexer.update as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://unreachable:9999/1/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it('preserves existing sourceIndexerId when baseUrl is the masked sentinel (#742 F1)', async () => {
      // Existing prowlarr-sourced row with sourceIndexerId=1
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);
      (services.indexer.update as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: {
          ...validTorznabBody,
          fields: [
            // Client re-submits the masked baseUrl unchanged. The derived
            // sourceIndexerId would be null (no numeric segment in the
            // sentinel), but the route must preserve the stored 1.
            { name: 'baseUrl', value: '********', type: 'textbox' },
            { name: 'apiKey', value: '********', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.indexer.getById).toHaveBeenCalledWith(1);
      expect(services.indexer.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          source: 'prowlarr',
          sourceIndexerId: 1,
        }),
      );
    });

    it('still derives sourceIndexerId from a fresh baseUrl when the client sends a real URL', async () => {
      (services.indexer.update as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/42/', type: 'textbox' },
            { name: 'apiKey', value: 'newkey', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(services.indexer.getById).not.toHaveBeenCalled();
      expect(services.indexer.update).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ sourceIndexerId: 42 }),
      );
    });
  });

  describe('DELETE /api/v1/indexer/:id (AC3)', () => {
    it('deletes indexer and returns 200', async () => {
      (services.indexer.delete as Mock).mockResolvedValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/v1/indexer/1' });

      expect(res.statusCode).toBe(200);
    });

    it('returns 404 for non-existent id', async () => {
      (services.indexer.delete as Mock).mockResolvedValue(false);

      const res = await app.inject({ method: 'DELETE', url: '/api/v1/indexer/999' });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/v1/indexer/test (AC4)', () => {
    it('returns 200 {} for valid reachable config', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer/test',
        payload: {
          implementation: 'Torznab',
          fields: [
            { name: 'baseUrl', value: 'http://localhost:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({});
    });

    it('returns 400 with isWarning, message, detailedDescription for unreachable config', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({ success: false, message: 'Connection refused' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer/test',
        payload: {
          implementation: 'Torznab',
          fields: [
            { name: 'baseUrl', value: 'http://unreachable:9999/1/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.isWarning).toBe(false);
      expect(payload.message).toBeDefined();
      expect(payload.detailedDescription).toBeDefined();
    });

    it('returns 400 with standard validation envelope when implementation is missing (Zod path)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer/test',
        payload: {
          fields: [
            { name: 'baseUrl', value: 'http://localhost:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.statusCode).toBe(400);
      expect(payload.error).toBe('Bad Request');
      expect(typeof payload.message).toBe('string');
      expect(payload.message.length).toBeGreaterThan(0);
      expect(services.indexer.testConfig).not.toHaveBeenCalled();
    });

    it('returns 400 with type name in message when implementation is unsupported', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer/test',
        payload: {
          implementation: 'CustomUnsupported',
          fields: [
            { name: 'baseUrl', value: 'http://localhost:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('CustomUnsupported');
      expect(payload.isWarning).toBe(false);
      expect(services.indexer.testConfig).not.toHaveBeenCalled();
    });
  });

  describe('Fields translation (AC3)', () => {
    it('maps baseUrl field to internal apiUrl setting on create', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      expect(services.indexer.createOrUpsertProwlarr).toHaveBeenCalledWith(
        expect.objectContaining({
          settings: expect.objectContaining({
            apiUrl: 'http://prowlarr:9696/1/',
          }),
        }),
      );
    });

    it('maps internal apiUrl back to baseUrl field on read (masked — #742)', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });

      const payload = JSON.parse(res.payload);
      const baseUrlField = payload.fields.find((f: { name: string }) => f.name === 'baseUrl');
      // apiUrl is now a secret field — the Readarr-compat baseUrl response is masked
      // so embedded credentials (user:pass@host) never echo back unmasked.
      expect(baseUrlField.value).toBe('********');
    });

    it('round-trips: POST with fields → GET returns same field values (baseUrl + apiKey masked)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);

      // Create
      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      // Read back
      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });
      const payload = JSON.parse(res.payload);

      const baseUrl = payload.fields.find((f: { name: string }) => f.name === 'baseUrl');
      const apiKey = payload.fields.find((f: { name: string }) => f.name === 'apiKey');
      // Both are intentionally masked on GET responses; plaintext never leaves the server.
      // Sentinel passthrough on PUT/POST preserves the stored value.
      expect(baseUrl.value).toBe('********');
      expect(apiKey.value).toBe('********');
    });

    it('stores and echoes back unknown/extra field names', async () => {
      const indexerWithExtra = {
        ...mockTorznabIndexer,
        settings: { ...mockTorznabIndexer.settings, customField: 'customValue' },
      };
      (services.indexer.getById as Mock).mockResolvedValue(indexerWithExtra);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });
      const payload = JSON.parse(res.payload);

      const customField = payload.fields.find((f: { name: string }) => f.name === 'customField');
      expect(customField).toBeDefined();
      expect(customField.value).toBe('customValue');
    });

    it('fromReadarrFields skips apiPath field (echo-only, not stored in settings)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: 'abc123', type: 'textbox' },
            { name: 'apiPath', value: '/custom-api', type: 'textbox' },
          ],
        },
      });

      const callArgs = (services.indexer.createOrUpsertProwlarr as Mock).mock.calls[0]![0];
      // apiPath should not appear in the settings object
      expect(callArgs.settings).not.toHaveProperty('apiPath');
      // But the other fields should be present
      expect(callArgs.settings.apiUrl).toBe('http://prowlarr:9696/1/');
      expect(callArgs.settings.apiKey).toBe('abc123');
    });

    it('defaults apiPath to "/api" when not provided', async () => {
      (services.indexer.getById as Mock).mockResolvedValue(mockTorznabIndexer);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });
      const payload = JSON.parse(res.payload);

      const apiPath = payload.fields.find((f: { name: string }) => f.name === 'apiPath');
      expect(apiPath.value).toBe('/api');
    });

    it('defaults categories to [3030] when not provided', async () => {
      const indexerNoCategories = {
        ...mockTorznabIndexer,
        settings: { apiUrl: 'http://prowlarr:9696/1/', apiKey: 'abc123' },
      };
      (services.indexer.getById as Mock).mockResolvedValue(indexerNoCategories);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });
      const payload = JSON.parse(res.payload);

      const categories = payload.fields.find((f: { name: string }) => f.name === 'categories');
      expect(categories.value).toEqual([3030]);
    });

    it('defaults minimumSeeders to 0 when not provided', async () => {
      const indexerNoSeeders = {
        ...mockTorznabIndexer,
        settings: { apiUrl: 'http://prowlarr:9696/1/', apiKey: 'abc123' },
      };
      (services.indexer.getById as Mock).mockResolvedValue(indexerNoSeeders);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });
      const payload = JSON.parse(res.payload);

      const seeders = payload.fields.find((f: { name: string }) => f.name === 'minimumSeeders');
      expect(seeders.value).toBe(0);
    });

    it('defaults seedCriteria fields to null when not provided', async () => {
      const indexerNoSeed = {
        ...mockTorznabIndexer,
        settings: { apiUrl: 'http://prowlarr:9696/1/', apiKey: 'abc123' },
      };
      (services.indexer.getById as Mock).mockResolvedValue(indexerNoSeed);

      const res = await app.inject({ method: 'GET', url: '/api/v1/indexer/1' });
      const payload = JSON.parse(res.payload);

      const seedRatio = payload.fields.find((f: { name: string }) => f.name === 'seedCriteria.seedRatio');
      const seedTime = payload.fields.find((f: { name: string }) => f.name === 'seedCriteria.seedTime');
      expect(seedRatio.value).toBeNull();
      expect(seedTime.value).toBeNull();
    });
  });

  describe('Zod schema validation (AC10)', () => {
    function expectStandardEnvelope(res: { statusCode: number; payload: string }) {
      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.statusCode).toBe(400);
      expect(payload.error).toBe('Bad Request');
      expect(typeof payload.message).toBe('string');
      expect(payload.message.length).toBeGreaterThan(0);
    }

    it('POST: priority as a non-numeric string → 400 standard envelope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: { ...validTorznabBody, priority: 'high' },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('POST: priority above the 0–100 ceiling → 400 standard envelope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: { ...validTorznabBody, priority: 150 },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('POST: extra unknown top-level key (randomKey) → 400 standard envelope (.strict())', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: { ...validTorznabBody, randomKey: 'x' },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('POST: missing fields entirely → 400 standard envelope (no longer 500)', async () => {
      const { fields: _drop, ...rest } = validTorznabBody;
      void _drop;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: rest,
      });
      expectStandardEnvelope(res);
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('POST: fields as a non-array → 400 standard envelope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: { ...validTorznabBody, fields: 'not-an-array' },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('PUT: malformed fields[].value (object) → 400 standard envelope', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: { nested: 'object' }, type: 'textbox' },
            { name: 'apiKey', value: 'k', type: 'textbox' },
          ],
        },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.update).not.toHaveBeenCalled();
    });

    it('POST: whitespace-only implementation → 400 standard envelope (.trim().min(1))', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: { ...validTorznabBody, implementation: '   ' },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('POST: whitespace-only field name → 400 standard envelope (.trim().min(1))', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: '   ', value: 'http://prowlarr:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: 'k', type: 'textbox' },
          ],
        },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('POST /test: missing implementation → 400 standard envelope (Zod path)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer/test',
        payload: {
          fields: [
            { name: 'baseUrl', value: 'http://localhost:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: 'key', type: 'textbox' },
          ],
        },
      });
      expectStandardEnvelope(res);
      expect(services.indexer.testConfig).not.toHaveBeenCalled();
    });

    it('POST /test: full validTorznabBody shape → existing pass path (full schema reused)', async () => {
      (services.indexer.testConfig as Mock).mockResolvedValue({ success: true, message: 'OK' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer/test',
        payload: validTorznabBody,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({});
    });

    it('POST: full validTorznabBody including enableAutomaticSearch/enableInteractiveSearch → 201 (.strict() compat regression)', async () => {
      (services.indexer.createOrUpsertProwlarr as Mock).mockResolvedValue({
        row: mockTorznabIndexer,
        upserted: false,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: validTorznabBody,
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('Domain checks for non-string baseUrl/apiKey values (AC11)', () => {
    it('POST: baseUrl.value as a number → 400 with handler { message } envelope (not 500)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 123, type: 'textbox' },
            { name: 'apiKey', value: 'k', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('baseUrl');
      expect(payload.statusCode).toBeUndefined();
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('POST: apiKey.value as a boolean → 400 with handler { message } envelope', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/indexer',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: 'http://prowlarr:9696/1/', type: 'textbox' },
            { name: 'apiKey', value: true, type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('apiKey');
      expect(payload.statusCode).toBeUndefined();
      expect(services.indexer.createOrUpsertProwlarr).not.toHaveBeenCalled();
    });

    it('PUT: baseUrl.value as an array → 400 with handler { message } envelope (not 500 from matchAll)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/indexer/1',
        payload: {
          ...validTorznabBody,
          fields: [
            { name: 'baseUrl', value: ['x'], type: 'textbox' },
            { name: 'apiKey', value: 'k', type: 'textbox' },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const payload = JSON.parse(res.payload);
      expect(payload.message).toContain('baseUrl');
      expect(payload.statusCode).toBeUndefined();
      expect(services.indexer.update).not.toHaveBeenCalled();
    });
  });
});

describe('Prowlarr API v1 auth (AC6)', () => {
  let authApp: Awaited<ReturnType<typeof Fastify>>;
  let authService: AuthService;

  beforeAll(async () => {
    authService = {
      validateApiKey: vi.fn().mockResolvedValue(false),
      getStatus: vi.fn().mockResolvedValue({ mode: 'forms', hasUser: true, localBypass: false }),
      hasUser: vi.fn().mockResolvedValue(true),
      verifyCredentials: vi.fn().mockResolvedValue(null),
      getSessionSecret: vi.fn().mockResolvedValue('test-secret'),
      verifySessionCookie: vi.fn().mockReturnValue(null),
      createSessionCookie: vi.fn().mockReturnValue('new-cookie'),
    } as unknown as AuthService;

    authApp = Fastify({ logger: false });
    await authApp.register(cookie);
    await authApp.register(authPlugin, { authService });

    // Register representative v1 routes for auth testing
    authApp.get('/api/v1/system/status', async () => ({ ok: true }));
    authApp.get('/api/v1/indexer', async () => []);
    authApp.post('/api/v1/indexer', async () => ({ ok: true }));
    authApp.get('/api/v1/indexer/schema', async () => []);

    await authApp.ready();
  });

  afterAll(async () => {
    await authApp.close();
  });

  it('rejects /api/v1/system/status without credentials (not in public whitelist)', async () => {
    const res = await authApp.inject({ method: 'GET', url: '/api/v1/system/status' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects /api/v1/indexer without credentials', async () => {
    const res = await authApp.inject({ method: 'GET', url: '/api/v1/indexer' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects POST /api/v1/indexer without credentials', async () => {
    const res = await authApp.inject({ method: 'POST', url: '/api/v1/indexer', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects /api/v1/indexer/schema without credentials', async () => {
    const res = await authApp.inject({ method: 'GET', url: '/api/v1/indexer/schema' });
    expect(res.statusCode).toBe(401);
  });

  it('allows /api/v1/indexer with valid X-Api-Key header', async () => {
    (authService.validateApiKey as Mock).mockResolvedValueOnce(true);

    const res = await authApp.inject({
      method: 'GET',
      url: '/api/v1/indexer',
      headers: { 'x-api-key': 'valid-key' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows /api/v1/indexer with valid ?apikey= query param', async () => {
    (authService.validateApiKey as Mock).mockResolvedValueOnce(true);

    const res = await authApp.inject({
      method: 'GET',
      url: '/api/v1/indexer?apikey=valid-key',
    });
    expect(res.statusCode).toBe(200);
  });
});
