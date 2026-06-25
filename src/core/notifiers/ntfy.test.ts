import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { NtfyNotifier } from './ntfy.js';
import type { EventPayload } from './types.js';

import * as fetchModule from '../utils/network-service.js';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('NtfyNotifier', () => {
  it('sends to default ntfy.sh server', async () => {
    let capturedBody = '';
    let capturedHeaders: Record<string, string> = {};

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        capturedBody = await request.text();
        capturedHeaders = Object.fromEntries(request.headers.entries());
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    expect(capturedHeaders.title).toBe('Release Grabbed');
    expect(capturedBody).toContain('Dune');
  });

  it('sends Authorization: Bearer header when accessToken is set', async () => {
    let capturedHeaders: Record<string, string> = {};

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        capturedHeaders = Object.fromEntries(request.headers.entries());
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic', accessToken: 'tk_abc123' });
    const result = await notifier.send('on_grab', { event: 'on_grab', book: { title: 'Dune' } });

    expect(result.success).toBe(true);
    expect(capturedHeaders.authorization).toBe('Bearer tk_abc123');
  });

  it('omits Authorization header when accessToken is unset or empty', async () => {
    const captured: Array<Record<string, string>> = [];

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        captured.push(Object.fromEntries(request.headers.entries()));
        return new HttpResponse('ok');
      }),
    );

    await new NtfyNotifier({ topic: 'my-topic' }).send('on_grab', { event: 'on_grab' });
    await new NtfyNotifier({ topic: 'my-topic', accessToken: '' }).send('on_grab', { event: 'on_grab' });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.authorization).toBeUndefined();
    expect(captured[1]!.authorization).toBeUndefined();
  });

  it.each(['min', 'low', 'default', 'high', 'max'])('sends Priority header for priority %s', async (priority) => {
    let capturedHeaders: Record<string, string> = {};

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        capturedHeaders = Object.fromEntries(request.headers.entries());
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic', priority });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(true);
    expect(capturedHeaders.priority).toBe(priority);
  });

  it('omits Priority header when priority is unset or empty', async () => {
    const captured: Array<Record<string, string>> = [];

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        captured.push(Object.fromEntries(request.headers.entries()));
        return new HttpResponse('ok');
      }),
    );

    await new NtfyNotifier({ topic: 'my-topic' }).send('on_grab', { event: 'on_grab' });
    await new NtfyNotifier({ topic: 'my-topic', priority: '' }).send('on_grab', { event: 'on_grab' });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.priority).toBeUndefined();
    expect(captured[1]!.priority).toBeUndefined();
  });

  it('returns failure on non-OK response even with token + priority set', async () => {
    server.use(
      http.post('https://ntfy.sh/my-topic', () => new HttpResponse('forbidden', { status: 403 })),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic', accessToken: 'tk', priority: 'high' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('403');
  });

  it('sends to custom server URL', async () => {
    server.use(
      http.post('https://my-ntfy.example.com/alerts', async () => {
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'alerts', serverUrl: 'https://my-ntfy.example.com' });
    const result = await notifier.send('on_grab', { event: 'on_grab', book: { title: 'Test' } });

    expect(result.success).toBe(true);
  });

  it('strips trailing slashes from server URL', async () => {
    server.use(
      http.post('https://my-ntfy.example.com/alerts', async () => {
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'alerts', serverUrl: 'https://my-ntfy.example.com/' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(true);
  });

  it('returns failure on non-2xx response', async () => {
    server.use(
      http.post('https://ntfy.sh/my-topic', () => new HttpResponse('unauthorized', { status: 401 })),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('unauthorized');
  });

  it('returns timeout error on slow response', async () => {
    server.use(
      http.post('https://ntfy.sh/my-topic', async () => {
        await new Promise((r) => setTimeout(r, 15_000));
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Request timed out');
  }, 15_000);

  it('formats on_health_issue message', async () => {
    let capturedBody = '';

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        capturedBody = await request.text();
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    await notifier.send('on_health_issue', {
      event: 'on_health_issue',
      health: { checkName: 'library_root', previousState: 'healthy', currentState: 'error', message: 'Path not found' },
    });

    expect(capturedBody).toContain('library_root');
    expect(capturedBody).toContain('Path not found');
  });

  it('on_failure body includes the book title', async () => {
    let capturedBody = '';

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        capturedBody = await request.text();
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    await notifier.send('on_failure', {
      event: 'on_failure',
      book: { title: 'Wool', author: 'Hugh Howey' },
      error: { message: 'Duplicate filename found', stage: 'import' },
    });

    expect(capturedBody).toContain('Wool');
    expect(capturedBody).toContain('Duplicate filename found');
    expect(capturedBody).toContain('(import)');
  });

  it('test() sends a test notification', async () => {
    server.use(
      http.post('https://ntfy.sh/my-topic', () => new HttpResponse('ok')),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    const result = await notifier.test();

    expect(result.success).toBe(true);
  });

  // --- #199 error-handling and boundary tests ---

  it('returns stringified value for non-Error thrown value', async () => {
    const spy = vi.spyOn(fetchModule, 'fetchWithTimeout').mockRejectedValueOnce('string-error');

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('string-error');
    spy.mockRestore();
  });

  it('falls back to empty string when response.text() rejects', async () => {
    server.use(
      http.post('https://ntfy.sh/my-topic', () => {
        const body = new ReadableStream({
          start(controller) {
            controller.error(new Error('stream broken'));
          },
        });
        return new HttpResponse(body, { status: 500 });
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('HTTP 500: ');
  });

  it('returns error message for non-timeout network error', async () => {
    const spy = vi.spyOn(fetchModule, 'fetchWithTimeout').mockRejectedValueOnce(new Error('network down'));

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('network down');
    spy.mockRestore();
  });

  it('normalizes multiple trailing slashes in serverUrl', async () => {
    server.use(
      http.post('https://ntfy.example.com/alerts', () => new HttpResponse('ok')),
    );

    const notifier = new NtfyNotifier({ topic: 'alerts', serverUrl: 'https://ntfy.example.com///' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(true);
  });
});
