import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmailNotifier } from './email.js';
import type { EventPayload } from './types.js';

vi.mock('nodemailer', () => ({
  createTransport: vi.fn(),
}));

import { createTransport } from 'nodemailer';

const mockSendMail = vi.fn();
const mockedCreateTransport = vi.mocked(createTransport);

beforeEach(() => {
  vi.clearAllMocks();
  mockSendMail.mockResolvedValue({ messageId: '<test@example.com>' });
  mockedCreateTransport.mockReturnValue({ sendMail: mockSendMail } as never);
});

const config = {
  host: 'smtp.example.com',
  port: 587,
  user: 'user@example.com',
  pass: 'secret',
  tls: false,
  from: 'narratorr@example.com',
  to: 'user@example.com',
};

describe('EmailNotifier', () => {
  it('sends email with correct SMTP config', async () => {
    const notifier = new EmailNotifier(config);
    const payload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Dune', author: 'Frank Herbert' },
    };

    const result = await notifier.send('on_grab', payload);

    expect(result.success).toBe(true);
    expect(mockedCreateTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'user@example.com', pass: 'secret' },
    });
    expect(mockSendMail).toHaveBeenCalledWith({
      from: 'narratorr@example.com',
      to: 'user@example.com',
      subject: 'Narratorr — Release Grabbed',
      text: expect.stringContaining('Dune'),
    });
  });

  it('returns failure on SMTP auth error', async () => {
    mockSendMail.mockRejectedValue(new Error('Invalid login: 535 authentication failed'));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('SMTP authentication failed');
  });

  it('returns failure on TLS error', async () => {
    mockSendMail.mockRejectedValue(new Error('TLS handshake failed: self-signed certificate'));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('TLS connection failed');
  });

  it('returns failure on generic error', async () => {
    mockSendMail.mockRejectedValue(new Error('Connection refused'));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Connection refused');
  });

  it('formats on_health_issue message with check details', async () => {
    const notifier = new EmailNotifier(config);
    const payload: EventPayload = {
      event: 'on_health_issue',
      health: { checkName: 'indexer:NZBGeek', previousState: 'healthy', currentState: 'error', message: 'Connection timeout' },
    };

    await notifier.send('on_health_issue', payload);

    const sentText = mockSendMail.mock.calls[0]![0].text as string;
    expect(sentText).toContain('indexer:NZBGeek');
    expect(sentText).toContain('healthy');
    expect(sentText).toContain('error');
    expect(sentText).toContain('Connection timeout');
  });

  it('test() sends a test notification', async () => {
    const notifier = new EmailNotifier(config);
    const result = await notifier.test();

    expect(result.success).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Narratorr — Release Grabbed' }),
    );
  });

  it('omits auth when no user provided', async () => {
    const { user: _user, pass: _pass, ...noAuthConfig } = config;
    const notifier = new EmailNotifier(noAuthConfig);
    await notifier.send('on_grab', { event: 'on_grab' });

    expect(mockedCreateTransport).toHaveBeenCalledWith(
      expect.objectContaining({ auth: undefined }),
    );
  });
});
