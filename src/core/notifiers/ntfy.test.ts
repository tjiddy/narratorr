import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach, type Mock } from 'vitest';
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { NtfyNotifier } from './ntfy.js';
import type { EventPayload } from './types.js';

import * as fetchModule from '../utils/fetch-with-timeout.js';
import { lookup as dnsLookup } from 'node:dns/promises';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  mockedDnsLookup.mockReset();
  // Default DNS to a public IP so SSRF preflight passes for all tests.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

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

  it('formats on_upgrade message', async () => {
    let capturedBody = '';

    server.use(
      http.post('https://ntfy.sh/my-topic', async ({ request }) => {
        capturedBody = await request.text();
        return new HttpResponse('ok');
      }),
    );

    const notifier = new NtfyNotifier({ topic: 'my-topic' });
    await notifier.send('on_upgrade', {
      event: 'on_upgrade',
      book: { title: 'Dune' },
      upgrade: { previousMbPerHour: 32.5, newMbPerHour: 58.1, previousCodec: 'mp3', newCodec: 'm4b' },
    });

    expect(capturedBody).toContain('32.5 MB/hr');
    expect(capturedBody).toContain('58.1 MB/hr');
  });

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

  it('returns failure with the underlying error when upstream stream breaks (#877 F1)', async () => {
    // Hardened fetchWithTimeout reads the body in the wrapper and propagates
    // any non-cap read failure rather than returning a partial buffer.
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
    expect(result.message).toContain('stream broken');
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
