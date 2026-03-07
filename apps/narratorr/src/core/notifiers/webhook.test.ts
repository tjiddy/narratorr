import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { WebhookNotifier } from './webhook.js';
import type { EventPayload } from './types.js';

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('WebhookNotifier', () => {
  it('sends POST request with default JSON body', async () => {
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> = {};

    server.use(
      http.post('https://example.com/hook', async ({ request }) => {
        capturedHeaders = Object.fromEntries(request.headers.entries());
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new WebhookNotifier({ url: 'https://example.com/hook' });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
      release: { title: 'Dune Audiobook', indexer: 'ABB', size: 500_000_000 },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    expect(capturedHeaders['content-type']).toBe('application/json');
    expect(capturedBody).toMatchObject({
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
      release: { title: 'Dune Audiobook' },
    });
  });

  it('sends with custom method and headers', async () => {
    let capturedMethod = '';
    let capturedHeaders: Record<string, string> = {};

    server.use(
      http.put('https://example.com/hook', async ({ request }) => {
        capturedMethod = request.method;
        capturedHeaders = Object.fromEntries(request.headers.entries());
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new WebhookNotifier({
      url: 'https://example.com/hook',
      method: 'PUT',
      headers: { 'X-Custom': 'test-value' },
    });

    const result = await notifier.send('on_import', { event: 'on_import' });

    expect(result.success).toBe(true);
    expect(capturedMethod).toBe('PUT');
    expect(capturedHeaders['x-custom']).toBe('test-value');
  });

  it('renders body template with token substitution', async () => {
    let capturedBody = '';

    server.use(
      http.post('https://example.com/hook', async ({ request }) => {
        capturedBody = await request.text();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new WebhookNotifier({
      url: 'https://example.com/hook',
      bodyTemplate: '{"title": "{book.title}", "by": "{book.author}", "evt": "{event}"}',
    });

    await notifier.send('on_grab', {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    });

    const parsed = JSON.parse(capturedBody);
    expect(parsed).toEqual({
      title: 'Dune',
      by: 'Frank Herbert',
      evt: 'on_grab',
    });
  });

  it('renders upgrade template tokens', async () => {
    let capturedBody = '';

    server.use(
      http.post('https://example.com/hook', async ({ request }) => {
        capturedBody = await request.text();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new WebhookNotifier({
      url: 'https://example.com/hook',
      bodyTemplate: '{"prev": "{upgrade.previousMbPerHour}", "new": "{upgrade.newMbPerHour}", "codec": "{upgrade.newCodec}"}',
    });

    await notifier.send('on_upgrade', {
      event: 'on_upgrade',
      book: { title: 'Dune' },
      upgrade: { previousMbPerHour: 64, newMbPerHour: 128, newCodec: 'aac' },
    } as EventPayload);

    const parsed = JSON.parse(capturedBody);
    expect(parsed).toEqual({
      prev: '64',
      new: '128',
      codec: 'aac',
    });
  });

  it('renders health template tokens', async () => {
    let capturedBody = '';

    server.use(
      http.post('https://example.com/hook', async ({ request }) => {
        capturedBody = await request.text();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new WebhookNotifier({
      url: 'https://example.com/hook',
      bodyTemplate: '{"check": "{health.checkName}", "state": "{health.currentState}", "msg": "{health.message}"}',
    });

    await notifier.send('on_health_issue', {
      event: 'on_health_issue',
      health: { checkName: 'Disk', previousState: 'healthy', currentState: 'error', message: 'Full' },
    } as EventPayload);

    const parsed = JSON.parse(capturedBody);
    expect(parsed).toEqual({
      check: 'Disk',
      state: 'error',
      msg: 'Full',
    });
  });

  it('returns failure on non-2xx response', async () => {
    server.use(
      http.post('https://example.com/hook', () => {
        return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
      }),
    );

    const notifier = new WebhookNotifier({ url: 'https://example.com/hook' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('500');
  });

  it('test() sends a test notification', async () => {
    let capturedBody: unknown;

    server.use(
      http.post('https://example.com/hook', async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new WebhookNotifier({ url: 'https://example.com/hook' });
    const result = await notifier.test();

    expect(result.success).toBe(true);
    expect(capturedBody).toMatchObject({
      event: 'on_grab',
      book: { title: 'Test Book' },
    });
  });
});
