import { createTransport } from 'nodemailer';
import type { NotifierAdapter, NotificationEvent, EventPayload } from './types.js';
import { formatEventMessage } from './types.js';

export interface EmailConfig {
  host: string;
  port?: number;
  user?: string;
  pass?: string;
  tls?: boolean;
  from: string;
  to: string;
}

const EVENT_SUBJECTS: Record<NotificationEvent, string> = {
  on_grab: 'Narratorr — Release Grabbed',
  on_download_complete: 'Narratorr — Download Complete',
  on_import: 'Narratorr — Import Complete',
  on_failure: 'Narratorr — Failure',
  on_upgrade: 'Narratorr — Quality Upgrade',
  on_health_issue: 'Narratorr — Health Issue',
};

export class EmailNotifier implements NotifierAdapter {
  readonly type = 'email';

  constructor(private config: EmailConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<{ success: boolean; message?: string }> {
    try {
      const transport = createTransport({
        host: this.config.host,
        port: this.config.port ?? 587,
        secure: this.config.tls ?? false,
        auth: this.config.user ? { user: this.config.user, pass: this.config.pass ?? '' } : undefined,
      });

      await transport.sendMail({
        from: this.config.from,
        to: this.config.to,
        subject: EVENT_SUBJECTS[event],
        text: formatEventMessage(event, payload),
      });

      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (msg.includes('authentication') || msg.includes('auth') || msg.includes('AUTH')) {
        return { success: false, message: 'SMTP authentication failed' };
      }
      if (msg.includes('TLS') || msg.includes('ssl') || msg.includes('certificate')) {
        return { success: false, message: `TLS connection failed: ${msg}` };
      }
      return { success: false, message: msg };
    }
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    const testPayload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Test Book', author: 'Test Author' },
    };

    return this.send('on_grab', testPayload);
  }
}
