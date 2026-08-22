import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';

/**
 * Pins that the e2e harness surfaces ERROR_REGISTRY statuses (#2460): before the harness
 * registered errorHandlerPlugin, every registry-mapped error read as a generic 500 in this tier,
 * so a deleted or changed mapping was invisible to every e2e suite. Zero mocks on purpose — the
 * rename-preview route rethrows RenameError NOT_FOUND, so a nonexistent id exercises the real
 * route → service → registry chain.
 */
describe('e2e harness — ERROR_REGISTRY statuses surface (#2460)', () => {
  let e2e: E2EApp;

  beforeEach(async () => {
    e2e = await createE2EApp();
  });

  afterEach(async () => {
    await e2e.cleanup();
  });

  it('maps RenameError NOT_FOUND to 404, not a generic 500', async () => {
    const res = await e2e.app.inject({ method: 'GET', url: '/api/books/999999/rename/preview' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Book not found' });
  });
});
