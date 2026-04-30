import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi, type Mock } from 'vitest';
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { GotifyNotifier } from './gotify.js';
import type { EventPayload } from './types.js';
import { lookup as dnsLookup } from 'node:dns/promises';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

const SERVER_URL = 'https://gotify.example.com';
const MESSAGE_URL = `${SERVER_URL}/message`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  mockedDnsLookup.mockReset();
  // Default DNS to a public IP so SSRF preflight passes for all tests.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('GotifyNotifier', () => {
  it('sends message with X-Gotify-Key header', async () => {
    let capturedBody: unknown;
    let capturedHeaders: Record<string, string> = {};

    server.use(
      http.post(MESSAGE_URL, async ({ request }) => {
        capturedBody = await request.json();
        capturedHeaders = Object.fromEntries(request.headers.entries());
        return HttpResponse.json({ id: 1 });
      }),
    );

    const notifier = new GotifyNotifier({ serverUrl: SERVER_URL, token: 'app-token' });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    expect(capturedHeaders['x-gotify-key']).toBe('app-token');
    const body = capturedBody as { title: string; message: string; priority: number };
    expect(body.title).toBe('Release Grabbed');
    expect(body.message).toContain('Dune');
    expect(body.priority).toBe(5);
  });

  it('sends higher priority for failure and health events', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(MESSAGE_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: 1 });
      }),
    );

    const notifier = new GotifyNotifier({ serverUrl: SERVER_URL, token: 'app-token' });
    await notifier.send('on_failure', { event: 'on_failure', error: { message: 'Import failed' } });

    const body = capturedBody as { priority: number };
    expect(body.priority).toBe(8);
  });

  it('returns failure on non-2xx response', async () => {
    server.use(
      http.post(MESSAGE_URL, () => HttpResponse.json({ error: 'Unauthorized' }, { status: 401 })),
    );

    const notifier = new GotifyNotifier({ serverUrl: SERVER_URL, token: 'bad' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
  });

  it('returns timeout error on slow response', async () => {
    server.use(
      http.post(MESSAGE_URL, async () => {
        await new Promise((r) => setTimeout(r, 15_000));
        return HttpResponse.json({ id: 1 });
      }),
    );

    const notifier = new GotifyNotifier({ serverUrl: SERVER_URL, token: 'app-token' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Request timed out');
  }, 15_000);

  it('strips trailing slashes from server URL', async () => {
    server.use(
      http.post(MESSAGE_URL, () => HttpResponse.json({ id: 1 })),
    );

    const notifier = new GotifyNotifier({ serverUrl: `${SERVER_URL}/`, token: 'app-token' });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(true);
  });

  it('formats on_upgrade message', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(MESSAGE_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: 1 });
      }),
    );

    const notifier = new GotifyNotifier({ serverUrl: SERVER_URL, token: 'app-token' });
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
      http.post(MESSAGE_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ id: 1 });
      }),
    );

    const notifier = new GotifyNotifier({ serverUrl: SERVER_URL, token: 'app-token' });
    await notifier.send('on_health_issue', {
      event: 'on_health_issue',
      health: { checkName: 'download_client:qBittorrent', previousState: 'warning', currentState: 'error', message: 'Connection refused' },
    });

    const body = capturedBody as { message: string; priority: number };
    expect(body.message).toContain('download_client:qBittorrent');
    expect(body.message).toContain('Connection refused');
    expect(body.priority).toBe(8);
  });

  it('test() sends a test notification', async () => {
    server.use(
      http.post(MESSAGE_URL, () => HttpResponse.json({ id: 1 })),
    );

    const notifier = new GotifyNotifier({ serverUrl: SERVER_URL, token: 'app-token' });
    const result = await notifier.test();

    expect(result.success).toBe(true);
  });
});
