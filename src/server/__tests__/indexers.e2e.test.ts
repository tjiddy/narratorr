import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';

describe('Indexers E2E', () => {
  let e2e: E2EApp;

  beforeAll(async () => {
    e2e = await createE2EApp();
  });

  afterAll(async () => {
    await e2e.cleanup();
  });

  it('GET /api/indexers returns empty array initially', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/indexers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST /api/indexers creates an indexer', async () => {
    const res = await e2e.app.inject({
      method: 'POST',
      url: '/api/indexers',
      payload: {
        name: 'Test Newznab',
        type: 'newznab',
        enabled: true,
        priority: 50,
        settings: { apiUrl: 'https://example.com/api', apiKey: 'test-key' },
      },
    });

    expect(res.statusCode).toBe(201);
    const indexer = res.json();
    expect(indexer.id).toBeDefined();
    expect(indexer.name).toBe('Test Newznab');
    expect(indexer.type).toBe('newznab');
  });

  it('GET /api/indexers/:id returns the created indexer', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/indexers' });
    const id = listRes.json()[0].id;

    const res = await e2e.app.inject({ method: 'GET', url: `/api/indexers/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Test Newznab');
  });

  it('PUT /api/indexers/:id updates an indexer', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/indexers' });
    const id = listRes.json()[0].id;

    const res = await e2e.app.inject({
      method: 'PUT',
      url: `/api/indexers/${id}`,
      payload: { name: 'Updated Newznab', priority: 75 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Updated Newznab');
    expect(res.json().priority).toBe(75);
  });

  it('DELETE /api/indexers/:id removes an indexer', async () => {
    const listRes = await e2e.app.inject({ method: 'GET', url: '/api/indexers' });
    const id = listRes.json()[0].id;

    const delRes = await e2e.app.inject({ method: 'DELETE', url: `/api/indexers/${id}` });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ success: true });

    const getRes = await e2e.app.inject({ method: 'GET', url: `/api/indexers/${id}` });
    expect(getRes.statusCode).toBe(404);
  });
});
