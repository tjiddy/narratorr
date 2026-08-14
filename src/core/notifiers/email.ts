import { createTransport } from 'nodemailer';
import type { NotifierAdapter, NotifierResult, NotificationEvent, EventPayload } from './types.js';
import { formatEventMessage } from './types.js';
import { classifyFailure, describeSmtpError } from '../utils/failure-classification.js';
import { getErrorMessage } from '@shared/error-message.js';

export interface EmailConfig {
  host: string;
  port?: number | undefined;
  user?: string | undefined;
  pass?: string | undefined;
  tls?: boolean | undefined;
  from: string;
  to: string;
}

const EVENT_SUBJECTS: Record<NotificationEvent, string> = {
  on_grab: 'Narratorr — Release Grabbed',
  on_download_complete: 'Narratorr — Download Complete',
  on_import: 'Narratorr — Import Complete',
  on_failure: 'Narratorr — Failure',
  on_health_issue: 'Narratorr — Health Issue',
  import_run_finished: 'Narratorr — Import Run Finished',
};

export class EmailNotifier implements NotifierAdapter {
  readonly type = 'email';

  constructor(private config: EmailConfig) {}

  async send(event: NotificationEvent, payload: EventPayload): Promise<NotifierResult> {
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
    } catch (error: unknown) {
      // Key on the SMTP reply code and Nodemailer's own error code, never on the message —
      // reply text varies by server and locale (#2312 AC3).
      const failure = describeSmtpError(error);
      const verdict = classifyFailure(failure);
      return {
        success: false,
        message: verdict.terminal ? verdict.reason : getErrorMessage(error),
        failure,
      };
    }
  }

  async test(): Promise<NotifierResult> {
    const testPayload: EventPayload = {
      event: 'on_grab',
      book: { title: 'Test Book', author: 'Test Author' },
    };

    return this.send('on_grab', testPayload);
  }
}
