import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { notifiers } from '../../db/schema.js';
import {
  ADAPTER_FACTORIES,
  type NotifierAdapter,
  type NotificationEvent,
  type EventPayload,
} from '../../core/index.js';
import { getErrorMessage } from '../utils/error-message.js';
import type { NotifierSettings } from '../../shared/schemas/notifier.js';

type NotifierRow = typeof notifiers.$inferSelect;
type NewNotifier = typeof notifiers.$inferInsert;

export class NotifierService {
  constructor(private db: Db, private log: FastifyBaseLogger) {}

  async getAll(): Promise<NotifierRow[]> {
    return this.db.select().from(notifiers);
  }

  async getById(id: number): Promise<NotifierRow | null> {
    const results = await this.db.select().from(notifiers).where(eq(notifiers.id, id)).limit(1);
    return results[0] || null;
  }

  async create(data: Omit<NewNotifier, 'id' | 'createdAt'>): Promise<NotifierRow> {
    const result = await this.db.insert(notifiers).values(data).returning();
    this.log.info({ name: data.name, type: data.type }, 'Notifier created');
    return result[0];
  }

  async update(id: number, data: Partial<NewNotifier>): Promise<NotifierRow | null> {
    const result = await this.db
      .update(notifiers)
      .set(data)
      .where(eq(notifiers.id, id))
      .returning();

    this.log.info({ id }, 'Notifier updated');
    return result[0] || null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(notifiers).where(eq(notifiers.id, id));
    this.log.info({ id }, 'Notifier deleted');
    return true;
  }

  /**
   * Fire-and-forget notification to all enabled notifiers matching the event.
   * Failures are logged but never thrown.
   */
  async notify(event: NotificationEvent, payload: EventPayload): Promise<void> {
    const enabledNotifiers = await this.db
      .select()
      .from(notifiers)
      .where(eq(notifiers.enabled, true));

    const matching = enabledNotifiers.filter((n) => {
      const events = Array.isArray(n.events) ? n.events : [];
      return events.includes(event);
    });

    if (matching.length === 0) {
      this.log.debug({ event }, 'No notifiers configured for event');
      return;
    }

    this.log.debug({ event, count: matching.length }, 'Sending notifications');

    await Promise.allSettled(
      matching.map(async (notifier) => {
        try {
          const adapter = this.createAdapter(notifier);
          const result = await adapter.send(event, payload);
          if (!result.success) {
            this.log.warn({ notifier: notifier.name, notifierType: notifier.type, event, message: result.message }, 'Notification failed');
          } else {
            this.log.debug({ notifier: notifier.name, notifierType: notifier.type, event }, 'Notification sent');
          }
        } catch (error: unknown) {
          this.log.warn({ notifier: notifier.name, notifierType: notifier.type, event, error }, 'Notification error');
        }
      }),
    );
  }

  async test(id: number): Promise<{ success: boolean; message?: string }> {
    const notifier = await this.getById(id);
    if (!notifier) {
      return { success: false, message: 'Notifier not found' };
    }

    try {
      const adapter = this.createAdapter(notifier);
      return await adapter.test();
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  async testConfig(data: { type: string; settings: Record<string, unknown> }): Promise<{ success: boolean; message?: string }> {
    try {
      const fakeRow = {
        id: 0, name: '', type: data.type, enabled: true,
        events: ['on_grab'], settings: data.settings, createdAt: new Date(),
      } as NotifierRow;
      const adapter = this.createAdapter(fakeRow);
      return await adapter.test();
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private createAdapter(notifier: NotifierRow): NotifierAdapter {
    const factory = ADAPTER_FACTORIES[notifier.type as keyof typeof ADAPTER_FACTORIES];
    if (!factory) throw new Error(`Unknown notifier type: ${notifier.type}`);

    const settings = notifier.settings as NotifierSettings;

    // Log warning for malformed webhook headers (factory silently ignores them)
    if (notifier.type === 'webhook') {
      const webhookSettings = settings as NotifierSettings & { headers?: string };
      if (typeof webhookSettings.headers === 'string') {
        try { JSON.parse(webhookSettings.headers); } catch {
          this.log.warn({ notifierId: notifier.id }, 'Failed to parse webhook headers JSON, ignoring');
        }
      }
    }

    return factory(settings);
  }
}
