import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { SlackNotifier } from './slack.js';
import type { EventPayload } from './types.js';

const WEBHOOK_URL = 'https://hooks.slack.com/services/T00/B00/xxxx';

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('SlackNotifier', () => {
  it('sends message with correct format', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse('ok');
      }),
    );

    const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    const body = capturedBody as { text: string };
    expect(body.text).toContain('*Release Grabbed*');
    expect(body.text).toContain('Dune');
  });

  it('returns failure on non-2xx response', async () => {
    server.use(
      http.post(WEBHOOK_URL, () => new HttpResponse('channel_not_found', { status: 404 })),
    );

    const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('404');
  });

  it('returns timeout error on slow response', async () => {
    server.use(
      http.post(WEBHOOK_URL, async () => {
        await new Promise((r) => setTimeout(r, 15_000));
        return new HttpResponse('ok');
      }),
    );

    const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Request timed out');
  }, 15_000);

  it('formats on_upgrade message', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse('ok');
      }),
    );

    const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
    await notifier.send('on_upgrade', {
      event: 'on_upgrade',
      book: { title: 'Dune' },
      upgrade: { previousMbPerHour: 32.5, newMbPerHour: 58.1, previousCodec: 'mp3', newCodec: 'm4b' },
    });

    const body = capturedBody as { text: string };
    expect(body.text).toContain('32.5 MB/hr');
    expect(body.text).toContain('58.1 MB/hr');
  });

  it('formats on_health_issue message', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(WEBHOOK_URL, async ({ request }) => {
        capturedBody = await request.json();
        return new HttpResponse('ok');
      }),
    );

    const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
    await notifier.send('on_health_issue', {
      event: 'on_health_issue',
      health: { checkName: 'disk_space', previousState: 'healthy', currentState: 'warning', message: '< 10GB free' },
    });

    const body = capturedBody as { text: string };
    expect(body.text).toContain('disk_space');
    expect(body.text).toContain('healthy');
  });

  it('test() sends a test notification', async () => {
    server.use(
      http.post(WEBHOOK_URL, () => new HttpResponse('ok')),
    );

    const notifier = new SlackNotifier({ webhookUrl: WEBHOOK_URL });
    const result = await notifier.test();

    expect(result.success).toBe(true);
  });
});
