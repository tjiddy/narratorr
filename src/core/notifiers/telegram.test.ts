import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { TelegramNotifier } from './telegram.js';
import type { EventPayload } from './types.js';

import * as fetchModule from '../utils/network-service.js';

const BOT_TOKEN = '123456:ABC-DEF';
const CHAT_ID = '-1001234567890';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('TelegramNotifier', () => {
  it('sends message with HTML parse mode', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    const body = capturedBody as { chat_id: string; text: string; parse_mode: string };
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('<b>Release Grabbed</b>');
    expect(body.text).toContain('Dune');
  });

  it('escapes HTML entities in user-supplied fields', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Books <script>&</script>', author: 'O\'Brien & Sons' },
    };

    await notifier.send('on_grab', payload);

    const body = capturedBody as { text: string };
    expect(body.text).not.toContain('<script>');
    expect(body.text).toContain('&lt;script&gt;');
    expect(body.text).toContain('&amp;');
  });

  it('returns failure on non-2xx response', async () => {
    server.use(
      http.post(API_URL, () => {
        return HttpResponse.json({ ok: false, description: 'Unauthorized' }, { status: 401 });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
  });

  it('returns timeout error on slow response', async () => {
    server.use(
      http.post(API_URL, async () => {
        await new Promise((r) => setTimeout(r, 15_000));
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Request timed out');
  }, 15_000);

  it('formats on_upgrade message', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const payload: EventPayload = {
      event: 'on_upgrade',
      book: { title: 'Dune', author: 'Frank Herbert' },
      upgrade: { previousMbPerHour: 32.5, newMbPerHour: 58.1, previousCodec: 'mp3', newCodec: 'm4b' },
    };

    await notifier.send('on_upgrade', payload);

    const body = capturedBody as { text: string };
    expect(body.text).toContain('32.5 MB/hr');
    expect(body.text).toContain('58.1 MB/hr');
  });

  it('formats on_health_issue message', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const payload: EventPayload = {
      event: 'on_health_issue',
      health: { checkName: 'indexer:NZBGeek', previousState: 'healthy', currentState: 'error', message: 'Connection timeout' },
    };

    await notifier.send('on_health_issue', payload);

    const body = capturedBody as { text: string };
    expect(body.text).toContain('indexer:NZBGeek');
    expect(body.text).toContain('healthy');
  });

  it('test() sends a test notification', async () => {
    server.use(
      http.post(API_URL, () => HttpResponse.json({ ok: true })),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const result = await notifier.test();

    expect(result.success).toBe(true);
  });

  // --- #199 error-handling and edge-case tests ---

  it('returns stringified value for non-Error thrown value', async () => {
    const spy = vi.spyOn(fetchModule, 'fetchWithTimeout').mockRejectedValueOnce('string-error');

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('string-error');
    spy.mockRestore();
  });

  it('falls back to empty string when response.text() rejects', async () => {
    server.use(
      http.post(API_URL, () => {
        const body = new ReadableStream({
          start(controller) {
            controller.error(new Error('stream broken'));
          },
        });
        return new HttpResponse(body, { status: 500 });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('HTTP 500: ');
  });

  it('returns error message for non-timeout network error', async () => {
    const spy = vi.spyOn(fetchModule, 'fetchWithTimeout').mockRejectedValueOnce(new Error('network down'));

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('network down');
    spy.mockRestore();
  });

  it('test() returns failure on 401 invalid-token response', async () => {
    server.use(
      http.post(API_URL, () => {
        return HttpResponse.json({ ok: false, description: 'Unauthorized' }, { status: 401 });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    const result = await notifier.test();

    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('Unauthorized');
  });

  it('does not escape quotes in HTML message body', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(API_URL, async ({ request }) => {
        capturedBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    const notifier = new TelegramNotifier({ botToken: BOT_TOKEN, chatId: CHAT_ID });
    await notifier.send('on_grab', {
      event: 'on_grab',
      book: { title: 'Book "With Quotes"', author: "O'Brien" },
    });

    const body = capturedBody as { text: string };
    expect(body.text).toContain('"With Quotes"');
    expect(body.text).toContain("O'Brien");
  });
});
