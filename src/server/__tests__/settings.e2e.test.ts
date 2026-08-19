import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { SECRET_CATEGORIES, SECRET_SETTINGS_CATEGORIES } from '../utils/secret-category-map.js';
import { DEFAULT_SETTINGS } from '@shared/schemas.js';

describe('Settings E2E', () => {
  let e2e: E2EApp;

  beforeAll(async () => {
    e2e = await createE2EApp();
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  it('GET /api/settings returns default settings', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const settings = res.json();
    expect(settings).toHaveProperty('library');
    expect(settings).toHaveProperty('search');
    expect(settings).toHaveProperty('general');
  });

  /**
   * The real service over the real (empty) settings table, so the endpoint composes its payload from
   * the packaged defaults. A consumer holding a never-written category must not be able to change
   * what the endpoint serves everyone else (#2455).
   */
  it('GET /api/settings serves the packaged default after a consumer mutates a never-written category', async () => {
    const pristineSystem = structuredClone(DEFAULT_SETTINGS.system);
    try {
      const held = await e2e.services.settings.get('system');
      held.backupRetention = 999;

      const res = await e2e.app.inject({ method: 'GET', url: '/api/settings' });

      expect(res.statusCode).toBe(200);
      expect(res.json().system).toEqual(pristineSystem);
      expect(DEFAULT_SETTINGS.system).toEqual(pristineSystem);
    } finally {
      Object.assign(DEFAULT_SETTINGS.system, pristineSystem);
    }
  });

  it('PUT /api/settings updates library path', async () => {
    const res = await e2e.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        library: { path: '/tmp/test-library' },
      },
    });

    expect(res.statusCode).toBe(200);
    const settings = res.json();
    expect(settings.library.path).toBe('/tmp/test-library');
  });

  it('GET /api/settings reflects updated values', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json().library.path).toBe('/tmp/test-library');
  });

  it('PUT /api/settings updates search settings', async () => {
    const res = await e2e.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        search: { enabled: true },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().search.enabled).toBe(true);
  });

  it('PUT /api/settings updates general log level', async () => {
    const res = await e2e.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        general: { logLevel: 'debug' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().general.logLevel).toBe('debug');
  });

  it('PUT /api/settings persists import.minSeedRatio and GET reflects it', async () => {
    const putRes = await e2e.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        import: { minSeedRatio: 1.5 },
      },
    });

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().import.minSeedRatio).toBe(1.5);

    const getRes = await e2e.app.inject({ method: 'GET', url: '/api/settings' });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().import.minSeedRatio).toBe(1.5);
  });

  it('GET /api/settings returns companionEpub disabled on a fresh DB', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json().companionEpub).toEqual({ enabled: false });
  });

  it('PUT /api/settings persists companionEpub.enabled and GET reflects it', async () => {
    const putRes = await e2e.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { companionEpub: { enabled: true } },
    });

    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().companionEpub.enabled).toBe(true);

    const getRes = await e2e.app.inject({ method: 'GET', url: '/api/settings' });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().companionEpub.enabled).toBe(true);
  });

  it('companionEpub is not a secret category — it holds no credential', () => {
    expect(SECRET_CATEGORIES).not.toHaveProperty('companionEpub');
    expect(SECRET_SETTINGS_CATEGORIES.map((e) => e.key)).not.toContain('companionEpub');
  });

  it('PUT /api/settings rejects negative minSeedRatio', async () => {
    const res = await e2e.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        import: { minSeedRatio: -1 },
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
