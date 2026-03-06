import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { NtfyNotifier } from './ntfy.js';
import type { EventPayload } from './types.js';

const server = setupServer();

beforeAll(() => server.listen());
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
});
