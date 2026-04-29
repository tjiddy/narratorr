import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { DiscordNotifier } from './discord.js';
import type { EventPayload } from './types.js';

const WEBHOOK_URL = 'https://discord.com/api/webhooks/123/abc';

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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
});
