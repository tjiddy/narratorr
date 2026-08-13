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

  it('sends import_run_finished with its subject + count-bearing body', async () => {
    const notifier = new EmailNotifier(config);
    const result = await notifier.send('import_run_finished', {
      event: 'import_run_finished',
      submission: { source: 'library', status: 'complete', counts: { accepted: 3, held: 1, skipped: 0, failed: 0 } },
    });
    expect(result.success).toBe(true);
    expect(mockSendMail).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Narratorr — Import Run Finished',
      text: 'Library import finished — 3 queued, 1 held, 0 skipped, 0 failed',
    }));
  });

  // Nodemailer rejects with the reply code on `responseCode` and its own catalogue code on
  // `code`; a fixture carrying only a message cannot exercise structural classification.
  function smtpError(message: string, fields: { responseCode?: number; code?: string }): Error {
    return Object.assign(new Error(message), fields);
  }

  it('surfaces the SMTP reply code as a failure descriptor and names auth in operator language', async () => {
    mockSendMail.mockRejectedValue(smtpError('Invalid login: 535 authentication failed', { responseCode: 535, code: 'EAUTH' }));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ smtpReplyCode: 535, errorCode: 'EAUTH' });
    expect(result.message).toBe('authentication rejected — check credentials');
  });

  it('surfaces the 554 recipient rejection as a terminal descriptor (#2312 incident)', async () => {
    mockSendMail.mockRejectedValue(smtpError('554 5.7.1 <x@y>: Recipient address rejected', { responseCode: 554, code: 'EENVELOPE' }));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.failure).toEqual({ smtpReplyCode: 554, errorCode: 'EENVELOPE' });
    expect(result.message).toBe('the mail server rejected the recipient or sender address');
  });

  it('surfaces a TLS failure by its structural code, with no reply code present', async () => {
    mockSendMail.mockRejectedValue(smtpError('self-signed certificate in certificate chain', { code: 'ETLS' }));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ errorCode: 'ETLS' });
    expect(result.message).toBe("TLS/certificate rejected — check the TLS setting and the server's certificate");
  });

  it('classifies on structure, not message text — reworded auth failure keeps its verdict (AC3)', async () => {
    mockSendMail.mockRejectedValue(smtpError('Anmeldung fehlgeschlagen', { responseCode: 535, code: 'EAUTH' }));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    // A message-substring implementation would find no 'auth' here and fall through.
    expect(result.message).toBe('authentication rejected — check credentials');
  });

  it('a transient failure whose text mentions authentication stays transient (AC3 inverse)', async () => {
    mockSendMail.mockRejectedValue(smtpError('421 authentication proxy temporarily unavailable', { responseCode: 421, code: 'ECONNECTION' }));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.failure).toEqual({ smtpReplyCode: 421, errorCode: 'ECONNECTION' });
    // Transient failures keep the transport's own wording rather than an operator verdict.
    expect(result.message).toBe('421 authentication proxy temporarily unavailable');
  });

  it('returns failure with an empty descriptor when the error carries no structure', async () => {
    mockSendMail.mockRejectedValue(new Error('Connection refused'));

    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Connection refused');
    expect(result.failure).toEqual({});
  });

  it('a successful send carries no failure descriptor', async () => {
    const notifier = new EmailNotifier(config);
    const result = await notifier.send('on_grab', { event: 'on_grab' });

    expect(result.success).toBe(true);
    expect(result.failure).toBeUndefined();
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
