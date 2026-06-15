import { describe, it, expect, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import { createMockDbConnector } from '../__tests__/factories.js';
import type { Services } from './index.js';

const validConfig = {
  type: 'audiobookshelf',
  settings: { baseUrl: 'http://abs.local:13378', apiKey: 'secret-key', libraryId: 'lib-1' },
};

const TARGETS = [{ id: 'lib-1', name: 'Audiobooks' }, { id: 'lib-2', name: 'Podcasts' }];

describe('connectors targets routes', () => {
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

  describe('POST /api/connectors/targets', () => {
    it('returns ConnectorTarget[] on success', async () => {
      (services.connector.listTargetsConfig as Mock).mockResolvedValue({ success: true, targets: TARGETS });

      const res = await app.inject({ method: 'POST', url: '/api/connectors/targets', payload: validConfig });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(TARGETS);
    });

    it('returns the field-scoped envelope when listTargetsConfig reports failure', async () => {
      (services.connector.listTargetsConfig as Mock).mockResolvedValue({
        success: false, message: 'Invalid API key', fieldErrors: { apiKey: 'Invalid API key' },
      });

      const res = await app.inject({ method: 'POST', url: '/api/connectors/targets', payload: validConfig });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: false, message: 'Invalid API key', fieldErrors: { apiKey: 'Invalid API key' } });
    });

    it('accepts the masked sentinel for the apiKey field (sentinel-aware schema)', async () => {
      (services.connector.listTargetsConfig as Mock).mockResolvedValue({ success: true, targets: TARGETS });

      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/targets',
        payload: { type: 'audiobookshelf', id: 5, settings: { baseUrl: 'http://abs.local', apiKey: '********', libraryId: 'lib-1' } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(TARGETS);
    });

    it('rejects an unknown settings key (strict per-type schema)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/targets',
        payload: { type: 'audiobookshelf', settings: { ...validConfig.settings, bogus: 'x' } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/connectors/:id/targets', () => {
    it('returns ConnectorTarget[] for a saved connector', async () => {
      (services.connector.getById as Mock).mockResolvedValue(createMockDbConnector());
      (services.connector.listTargets as Mock).mockResolvedValue({ success: true, targets: TARGETS });

      const res = await app.inject({ method: 'GET', url: '/api/connectors/1/targets' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(TARGETS);
    });

    it('returns 404 for an unknown connector id', async () => {
      (services.connector.getById as Mock).mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/connectors/999/targets' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Connector not found' });
    });

    it('translates a saved-config listTargets failure into the field-scoped envelope', async () => {
      (services.connector.getById as Mock).mockResolvedValue(createMockDbConnector());
      (services.connector.listTargets as Mock).mockResolvedValue({
        success: false, message: 'Library not found', fieldErrors: { libraryId: 'Library not found' },
      });

      const res = await app.inject({ method: 'GET', url: '/api/connectors/1/targets' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: false, message: 'Library not found', fieldErrors: { libraryId: 'Library not found' } });
    });
  });
});
