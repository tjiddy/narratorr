import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';

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
});
