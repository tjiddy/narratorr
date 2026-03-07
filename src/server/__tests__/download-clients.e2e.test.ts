import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';

describe('Download Clients E2E', () => {
  let e2e: E2EApp;

  beforeAll(async () => {
    e2e = await createE2EApp();
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  it('GET /api/download-clients returns empty array initially', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/download-clients' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST /api/download-clients creates a download client', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/download-clients',
      payload: {
        name: 'Test qBittorrent',
        type: 'qbittorrent',
        enabled: true,
        priority: 50,
        settings: { host: 'localhost', port: 8080, username: 'admin', password: 'admin' },
      },
    });

    expect(res.statusCode).toBe(201);
    const client = res.json();
    expect(client.id).toBeDefined();
    expect(client.name).toBe('Test qBittorrent');
    expect(client.type).toBe('qbittorrent');
  });

  it('GET /api/download-clients/:id returns the created client', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/download-clients' });
    const id = listRes.json()[0].id;

    const res = await e2e.app.inject({ method: 'GET', url: `/api/download-clients/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Test qBittorrent');
  });

  it('PUT /api/download-clients/:id updates a client', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/download-clients' });
    const id = listRes.json()[0].id;

    const res = await e2e.app.inject({
      method: 'PUT',
      url: `/api/download-clients/${id}`,
      payload: { name: 'Updated qBittorrent', priority: 25 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated qBittorrent');
    expect(res.json().priority).toBe(25);
  });

  it('DELETE /api/download-clients/:id removes a client', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/download-clients' });
    const id = listRes.json()[0].id;

    const delRes = await e2e.app.inject({ method: 'DELETE', url: `/api/download-clients/${id}` });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ success: true });

    const getRes = await e2e.app.inject({ method: 'GET', url: `/api/download-clients/${id}` });
    expect(getRes.statusCode).toBe(404);
  });
});
