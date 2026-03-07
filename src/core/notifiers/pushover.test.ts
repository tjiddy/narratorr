import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { PushoverNotifier } from './pushover.js';
import type { EventPayload } from './types.js';

const API_URL = 'https://api.pushover.net/1/messages.json';

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('PushoverNotifier', () => {
  it('sends message with token and user', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ status: 1 });
      }),
    );

    const notifier = new PushoverNotifier({ token: 'app-token', user: 'user-key' });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    const body = capturedBody as { token: string; user: string; title: string; message: string };
    expect(body.token).toBe('app-token');
    expect(body.user).toBe('user-key');
    expect(body.title).toBe('Release Grabbed');
    expect(body.message).toContain('Dune');
  });

  it('returns failure on non-2xx response', async () => {
    server.use(
      http.post(API_URL, () => HttpResponse.json({ status: 0, errors: ['token is invalid'] }, { status: 400 })),
    );

    const notifier = new PushoverNotifier({ token: 'bad', user: 'user' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('400');
  });

  it('returns timeout error on slow response', async () => {
    server.use(
      http.post(API_URL, async () => {
        await new Promise((r) => setTimeout(r, 15_000));
        return HttpResponse.json({ status: 1 });
      }),
    );

    const notifier = new PushoverNotifier({ token: 'app-token', user: 'user-key' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Request timed out');
  }, 15_000);

  it('formats on_upgrade message', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ status: 1 });
      }),
    );

    const notifier = new PushoverNotifier({ token: 'app-token', user: 'user-key' });
    await notifier.send('on_upgrade', {
      event: 'on_upgrade',
      book: { title: 'Dune' },
      upgrade: { previousMbPerHour: 32.5, newMbPerHour: 58.1, previousCodec: 'mp3', newCodec: 'm4b' },
    });

    const body = capturedBody as { message: string };
    expect(body.message).toContain('32.5 MB/hr');
    expect(body.message).toContain('58.1 MB/hr');
  });

  it('formats on_health_issue message', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ status: 1 });
      }),
    );

    const notifier = new PushoverNotifier({ token: 'app-token', user: 'user-key' });
    await notifier.send('on_health_issue', {
      event: 'on_health_issue',
      health: { checkName: 'ffmpeg', previousState: 'healthy', currentState: 'error' },
    });

    const body = capturedBody as { message: string };
    expect(body.message).toContain('ffmpeg');
    expect(body.message).toContain('error');
  });

  it('test() sends a test notification', async () => {
    server.use(
      http.post(API_URL, () => HttpResponse.json({ status: 1 })),
    );

    const notifier = new PushoverNotifier({ token: 'app-token', user: 'user-key' });
    const result = await notifier.test();

    expect(result.success).toBe(true);
  });
});
