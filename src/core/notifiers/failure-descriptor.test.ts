import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ADAPTER_FACTORIES } from './registry.js';
import { NOTIFIER_TYPES, type NotifierType } from '@shared/notifier-registry.js';
import type { NotifierSettings } from '@shared/schemas/notifier.js';
import type { NotifierResult } from './types.js';

vi.mock('nodemailer', () => ({ createTransport: vi.fn() }));
// ScriptNotifier is this file's only execFile consumer, so a single callback shape suffices.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { createTransport } from 'nodemailer';
import { execFile } from 'node:child_process';

const mockSendMail = vi.fn();
const mockExecFile = vi.mocked(execFile);

const CONFIGS: Record<NotifierType, NotifierSettings> = {
  webhook: { url: 'https://hooks.test/hook' },
  discord: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
  script: { path: '/usr/local/bin/notify.sh' },
  email: { smtpHost: 'smtp.test', fromAddress: 'a@b.com', toAddress: 'c@d.com' },
  telegram: { botToken: 'tok123', chatId: '456' },
  slack: { webhookUrl: 'https://hooks.slack.com/test' },
  pushover: { pushoverToken: 'tok', pushoverUser: 'usr' },
  ntfy: { ntfyTopic: 'audiobooks' },
  gotify: { gotifyUrl: 'https://gotify.test', gotifyToken: 'tok' },
};

// Every type's failure identity, and the descriptor its adapter must surface for it.
const FAILURE_CASES: Record<NotifierType, { arrange: () => void; expected: Record<string, unknown> }> = {
  webhook: { arrange: () => arrangeHttp(401), expected: { httpStatus: 401 } },
  discord: { arrange: () => arrangeHttp(401), expected: { httpStatus: 401 } },
  telegram: { arrange: () => arrangeHttp(401), expected: { httpStatus: 401 } },
  slack: { arrange: () => arrangeHttp(401), expected: { httpStatus: 401 } },
  pushover: { arrange: () => arrangeHttp(401), expected: { httpStatus: 401 } },
  ntfy: { arrange: () => arrangeHttp(401), expected: { httpStatus: 401 } },
  gotify: { arrange: () => arrangeHttp(401), expected: { httpStatus: 401 } },
  email: {
    arrange: () => {
      mockSendMail.mockRejectedValue(
        Object.assign(new Error('554 5.7.1 Recipient address rejected'), { responseCode: 554, code: 'EENVELOPE' }),
      );
    },
    expected: { smtpReplyCode: 554, errorCode: 'EENVELOPE' },
  },
  script: {
    arrange: () => {
      mockExecFile.mockImplementation((_file, _opts, callback) => {
        const cb = callback as (...args: unknown[]) => void;
        cb(Object.assign(new Error('Command failed'), { code: 3, killed: false }), '', '');
        return {} as ReturnType<typeof execFile>;
      });
    },
    expected: { exitCode: 3 },
  },
};

function arrangeHttp(status: number): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status, statusText: 'Unauthorized' }));
}

function arrangeSuccess(type: NotifierType): void {
  if (type === 'email') {
    mockSendMail.mockResolvedValue({ messageId: '<ok@test>' });
    return;
  }
  if (type === 'script') {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });
    return;
  }
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
}

function send(type: NotifierType): Promise<NotifierResult> {
  return ADAPTER_FACTORIES[type](CONFIGS[type]).send('on_grab', { event: 'on_grab', book: { title: 'Dune' } });
}

describe('notifier failure descriptors (#2312 AC4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(createTransport).mockReturnValue({ sendMail: mockSendMail } as never);
    mockSendMail.mockReset();
  });

  it('covers every registered notifier type', () => {
    expect(Object.keys(FAILURE_CASES).sort()).toEqual([...NOTIFIER_TYPES].sort());
  });

  it.each(NOTIFIER_TYPES)('%s surfaces its structural code on a failed send', async (type) => {
    FAILURE_CASES[type].arrange();

    const result = await send(type);

    expect(result.success).toBe(false);
    expect(result.failure).toEqual(FAILURE_CASES[type].expected);
  });

  it.each(NOTIFIER_TYPES)('%s surfaces no failure descriptor on a successful send', async (type) => {
    arrangeSuccess(type);

    const result = await send(type);

    expect(result.success).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  // Discord's webhook legitimately answers 204. `response.ok` (200-299) stays the acceptance
  // rule for every HTTP adapter; a future "exactly 200" narrowing must red here.
  it.each(['webhook', 'discord', 'telegram', 'slack', 'pushover', 'ntfy', 'gotify'] as const)(
    '%s treats a 204 as success with no descriptor',
    async (type) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

      const result = await send(type);

      expect(result.success).toBe(true);
      expect(result.failure).toBeUndefined();
    },
  );

  it('the script adapter reports a timeout kill without inventing a terminal identity', async () => {
    mockExecFile.mockImplementation((_file, _opts, callback) => {
      const cb = callback as (...args: unknown[]) => void;
      cb(Object.assign(new Error('killed'), { killed: true }), '', '');
      return {} as ReturnType<typeof execFile>;
    });

    const result = await send('script');

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ killed: true });
  });

  it('an HTTP adapter reports the transport code when the request never completes', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND hooks.test'), { code: 'ENOTFOUND' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed', { cause }));

    const result = await send('webhook');

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ errorCode: 'ENOTFOUND' });
  });
});
