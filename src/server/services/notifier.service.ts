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
import { encryptFields, decryptFields, resolveSentinelFields, getKey, getSecretFieldNames } from '../utils/secret-codec.js';
import { AdapterCache } from '../utils/adapter-cache.js';
import { serializeError } from '../utils/serialize-error.js';
import type { NotifierRow } from './types.js';


type NewNotifier = typeof notifiers.$inferInsert;

export class NotifierService {
  private adapters = new AdapterCache<NotifierAdapter>();

  constructor(private db: Db, private log: FastifyBaseLogger) {}

  // Any path that reads notifier rows for adapter construction MUST run them
  // through decryptRow first — adapters need plaintext to fire real requests.
  // getAdapter() decrypts on cache miss; getById() decrypts on read.
  private decryptRow(row: NotifierRow): NotifierRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('notifier', s, getKey()) };
  }

  async getAll(): Promise<NotifierRow[]> {
    const rows = await this.db.select().from(notifiers);
    return rows.map((r) => this.decryptRow(r));
  }

  async getById(id: number): Promise<NotifierRow | null> {
    const results = await this.db.select().from(notifiers).where(eq(notifiers.id, id)).limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async create(data: Omit<NewNotifier, 'id' | 'createdAt'>): Promise<NotifierRow> {
    const toInsert = { ...data };
    if (toInsert.settings) {
      toInsert.settings = encryptFields('notifier', { ...(toInsert.settings as Record<string, unknown>) }, getKey());
    }
    const result = await this.db.insert(notifiers).values(toInsert).returning();
    this.log.info({ name: data.name, type: data.type }, 'Notifier created');
    return this.decryptRow(result[0]!);
  }

  async update(id: number, data: Partial<NewNotifier>): Promise<NotifierRow | null> {
    const toUpdate = { ...data };
    if (toUpdate.settings) {
      const settings = { ...(toUpdate.settings as Record<string, unknown>) };
      const existing = await this.db.select().from(notifiers).where(eq(notifiers.id, id)).limit(1);
      // Resolve sentinels against RAW (encrypted) existing settings — encryptFields
      // skips $ENC$-prefixed values, so unchanged secrets retain their stored bytes.
      resolveSentinelFields(settings, (existing[0]?.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('notifier'));
      toUpdate.settings = encryptFields('notifier', settings, getKey());
    }
    const result = await this.db
      .update(notifiers)
      .set(toUpdate)
      .where(eq(notifiers.id, id))
      .returning();

    this.adapters.delete(id);
    this.log.info({ id }, 'Notifier updated');
    const row = result[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(notifiers).where(eq(notifiers.id, id));
    this.adapters.delete(id);
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
          const adapter = this.getAdapter(notifier);
          const result = await adapter.send(event, payload);
          if (!result.success) {
            this.log.warn({ notifier: notifier.name, notifierType: notifier.type, event, message: result.message }, 'Notification failed');
          } else {
            this.log.debug({ notifier: notifier.name, notifierType: notifier.type, event }, 'Notification sent');
          }
        } catch (error: unknown) {
          this.log.warn({ notifier: notifier.name, notifierType: notifier.type, event, error: serializeError(error) }, 'Notification error');
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
      const adapter = this.getAdapter(notifier);
      return await adapter.test();
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<{ success: boolean; message?: string }> {
    try {
      this.log.debug({ type: data.type }, 'Testing notifier config');

      // When editing an existing notifier, resolve sentinel values against
      // the DECRYPTED saved settings — the adapter test needs real plaintext.
      let resolvedSettings = data.settings;
      if (data.id != null) {
        const existing = await this.getById(data.id);
        if (!existing) {
          return { success: false, message: 'Notifier not found' };
        }
        resolvedSettings = { ...data.settings };
        resolveSentinelFields(resolvedSettings, (existing.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('notifier'));
      }

      const fakeRow = {
        id: 0, name: '', type: data.type, enabled: true,
        events: ['on_grab'], settings: resolvedSettings, createdAt: new Date(),
      } as NotifierRow;
      const adapter = this.createAdapter(fakeRow);
      const result = await adapter.test();
      this.log.debug({ type: data.type, success: result.success, message: result.message }, 'Notifier config test result');
      return result;
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  /**
   * Resolve a cached adapter for the notifier, lazily creating + caching on
   * miss. Accepts either a raw row from the DB or one already decrypted —
   * decryptRow is idempotent on plaintext values.
   */
  getAdapter(notifier: NotifierRow): NotifierAdapter {
    let adapter = this.adapters.get(notifier.id);

    if (!adapter) {
      const decrypted = this.decryptRow(notifier);
      adapter = this.createAdapter(decrypted);
      this.adapters.set(notifier.id, adapter);
    }

    return adapter;
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

  clearAdapterCache(): void {
    this.adapters.clear();
  }
}
