import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi, type Mock } from 'vitest';
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { DiscordNotifier } from './discord.js';
import type { EventPayload } from './types.js';
import { lookup as dnsLookup } from 'node:dns/promises';

const mockedDnsLookup = vi.mocked(dnsLookup) as unknown as Mock;

const WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

beforeEach(() => {
  mockedDnsLookup.mockReset();
  // Default DNS to a public IP so SSRF preflight passes for all tests.
  mockedDnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('DiscordNotifier', () => {
  it('sends embed with correct structure for on_grab', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert', coverUrl: 'https://img.example.com/dune.jpg' },
      release: { title: 'Dune Audiobook', indexer: 'ABB', size: 500_000_000 },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    const body = capturedBody as { embeds: { title: string; color: number; fields: { name: string; value: string }[]; thumbnail?: { url: string } }[] };
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe('Release Grabbed');
    expect(body.embeds[0].color).toBe(0x3498db);
    expect(body.embeds[0].thumbnail).toEqual({ url: 'https://img.example.com/dune.jpg' });

    const fieldNames = body.embeds[0].fields.map((f) => f.name);
    expect(fieldNames).toContain('Book');
    expect(fieldNames).toContain('Author');
    expect(fieldNames).toContain('Indexer');
  });

  it('sends embed for on_import with library path and file count', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.send('on_import', {
      event: 'on_import',
      book: { title: 'Dune' },
      import: { libraryPath: '/audiobooks/Dune', fileCount: 12 },
    });

    expect(result.success).toBe(true);
    const body = capturedBody as { embeds: { title: string; fields: { name: string; value: string }[] }[] };
    expect(body.embeds[0].title).toBe('Import Complete');
    const fieldNames = body.embeds[0].fields.map((f) => f.name);
    expect(fieldNames).toContain('Library Path');
    expect(fieldNames).toContain('Files');
  });

  it('sends embed for on_failure with error details', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.send('on_failure', {
      event: 'on_failure',
      book: { title: 'Dune' },
      error: { message: 'No audio files found', stage: 'import' },
    });

    expect(result.success).toBe(true);
    const body = capturedBody as { embeds: { title: string; color: number; fields: { name: string; value: string }[] }[] };
    expect(body.embeds[0].title).toBe('Failure');
    expect(body.embeds[0].color).toBe(0xe74c3c);
    const errorField = body.embeds[0].fields.find((f) => f.name === 'Error');
    expect(errorField?.value).toBe('No audio files found');
  });

  it('excludes cover when includeCover is false', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL, includeCover: false });
    await notifier.send('on_grab', {
      event: 'on_grab',
      book: { title: 'Dune', coverUrl: 'https://img.example.com/dune.jpg' },
    });

    const body = capturedBody as { embeds: { thumbnail?: unknown }[] };
    expect(body.embeds[0].thumbnail).toBeUndefined();
  });

  it('returns failure on Discord error', async () => {
    server.use(
      http.post(WEBHOOK_URL, () => {
        return HttpResponse.json({ message: 'Invalid Webhook Token' }, { status: 401 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
  });

  it('sends embed for on_upgrade with quality fields', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.send('on_upgrade', {
      event: 'on_upgrade',
      book: { title: 'Dune', author: 'Frank Herbert' },
      upgrade: { previousMbPerHour: 32.5, newMbPerHour: 58.1, previousCodec: 'mp3', newCodec: 'm4b' },
    });

    expect(result.success).toBe(true);
    const body = capturedBody as { embeds: { title: string; color: number; fields: { name: string; value: string }[] }[] };
    expect(body.embeds[0].title).toBe('Quality Upgrade');
    expect(body.embeds[0].color).toBe(0x9b59b6);
    const prevField = body.embeds[0].fields.find((f) => f.name === 'Previous');
    const newField = body.embeds[0].fields.find((f) => f.name === 'New');
    expect(prevField?.value).toContain('32.5 MB/hr');
    expect(prevField?.value).toContain('MP3');
    expect(newField?.value).toContain('58.1 MB/hr');
    expect(newField?.value).toContain('M4B');
  });

  it('sends embed for on_health_issue with check and state fields', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.send('on_health_issue', {
      event: 'on_health_issue',
      health: { checkName: 'indexer:NZBGeek', previousState: 'healthy', currentState: 'error', message: 'Connection timeout' },
    });

    expect(result.success).toBe(true);
    const body = capturedBody as { embeds: { title: string; color: number; fields: { name: string; value: string }[] }[] };
    expect(body.embeds[0].title).toBe('Health Issue');
    expect(body.embeds[0].color).toBe(0xe67e22);
    const checkField = body.embeds[0].fields.find((f) => f.name === 'Check');
    const stateField = body.embeds[0].fields.find((f) => f.name === 'State');
    const detailField = body.embeds[0].fields.find((f) => f.name === 'Detail');
    expect(checkField?.value).toBe('indexer:NZBGeek');
    expect(stateField?.value).toContain('healthy');
    expect(stateField?.value).toContain('error');
    expect(detailField?.value).toBe('Connection timeout');
  });

  it('test() sends a test notification', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.test();

    expect(result.success).toBe(true);
    const body = capturedBody as { embeds: { title: string }[] };
    expect(body.embeds[0].title).toBe('Release Grabbed');
  });

  describe('SSRF hardening + RESPONSE_CAP_NOTIFIER (#877 F4)', () => {
    it.each([
      'http://192.168.1.1/discord',
      'http://127.0.0.1:8080/discord',
      'http://169.254.169.254/discord',
      'http://10.0.0.5/discord',
      'http://[::1]/discord',
      'http://metadata.google.internal/discord',
    ])('refuses user-configured Discord webhookUrl targeting %s before fetch', async (url) => {
      let fetchInvoked = false;
      server.use(
        http.post(/.*/, () => {
          fetchInvoked = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const notifier = new DiscordNotifier({ webhookUrl: url });
      await expect(notifier.send('on_grab', { event: 'on_grab' })).rejects.toThrow(/Refused/);
      expect(fetchInvoked).toBe(false);
    });

    it('refuses when DNS for a public-looking Discord webhookUrl resolves to a private address', async () => {
      mockedDnsLookup.mockReset();
      mockedDnsLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);

      let fetchInvoked = false;
      server.use(
        http.post(/.*/, () => {
          fetchInvoked = true;
          return new HttpResponse(null, { status: 204 });
        }),
      );

      const notifier = new DiscordNotifier({ webhookUrl: 'https://rebind.example.com/discord' });
      await expect(notifier.send('on_grab', { event: 'on_grab' })).rejects.toThrow(/Refused/);
      expect(fetchInvoked).toBe(false);
    });

    it('rejects when response Content-Length exceeds RESPONSE_CAP_NOTIFIER (64 KiB)', async () => {
      // Stub fetch directly — MSW would normalize Content-Length away.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('truncated-body', {
          status: 200,
          headers: { 'content-length': String(64 * 1024 + 1) },
        }),
      );

      const notifier = new DiscordNotifier({ webhookUrl: WEBHOOK_URL });
      await expect(notifier.send('on_grab', { event: 'on_grab' })).rejects.toThrow(/cap/i);
      fetchSpy.mockRestore();
    });
  });
});
