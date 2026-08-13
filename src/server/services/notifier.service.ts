import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { notifiers } from '@db/schema.js';
import {
  ADAPTER_FACTORIES,
  classifyFailure,
  describeTransportError,
  type NotifierAdapter,
  type NotifierResult,
  type NotificationEvent,
  type EventPayload,
} from '@core/index.js';
import { getErrorMessage } from '../utils/error-message.js';
import { notifierSettingsSchemas, type NotifierSettings } from '@shared/schemas/notifier.js';
import { parseEntitySettings } from '../utils/parse-entity-settings.js';
import { encryptFields, decryptFields, getKey } from '../utils/secret-codec.js';
import { resolveAndEncryptSettings, resolveSettings } from '../utils/sentinel-resolver.js';
import { AdapterCache } from '../utils/adapter-cache.js';
import { serializeError } from '../utils/serialize-error.js';
import type { NotifierRow } from './types.js';
import { NotifierFailureTracker, type NotifierFailureSnapshot } from './notifier-failure-state.js';


type NewNotifier = typeof notifiers.$inferInsert;

export interface NotifyOptions {
  /** Suppress one recipient for this dispatch only — see AC14 in #2312. */
  excludeNotifierId?: number;
}

/** Key-order-independent comparison, so a re-serialised settings object is not a change. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export class NotifierService {
  private adapters = new AdapterCache<NotifierAdapter>();
  private failures: NotifierFailureTracker;

  constructor(private db: Db, private log: FastifyBaseLogger, clock: () => number = Date.now) {
    this.failures = new NotifierFailureTracker(clock);
  }

  /** Observed delivery state for the health roster; never probes the adapter. */
  getFailureSnapshot(id: number): NotifierFailureSnapshot {
    return this.failures.get(id);
  }

  // Every adapter-construction path must decrypt settings first.
  private decryptRow(row: NotifierRow): NotifierRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('notifier', s, getKey(), this.log) };
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
    const existingRows = await this.db.select().from(notifiers).where(eq(notifiers.id, id)).limit(1);
    const existing = existingRows[0];

    const toUpdate = { ...data };
    if (toUpdate.settings) {
      toUpdate.settings = resolveAndEncryptSettings('notifier', toUpdate.settings as Record<string, unknown>, existing?.settings as Record<string, unknown> | undefined);
    }
    const result = await this.db
      .update(notifiers)
      .set(toUpdate)
      .where(eq(notifiers.id, id))
      .returning();

    // Adapter eviction stays unconditional; failure-state invalidation is conditional, so a
    // rename cannot reset a streak or re-fire a health transition that already fired.
    this.adapters.delete(id);
    if (this.isRepair(data, existing)) this.failures.clear(id);

    this.log.info({ id }, 'Notifier updated');
    const row = result[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  /** Only a change that could plausibly fix delivery clears the failure state. */
  private isRepair(data: Partial<NewNotifier>, existing: NotifierRow | undefined): boolean {
    if (!existing) return false;
    if (data.type !== undefined && data.type !== existing.type) return true;
    if (data.enabled !== undefined && data.enabled !== existing.enabled) return true;
    if (!data.settings) return false;

    // Compare RESOLVED PLAINTEXT, never the stored column: encrypt() re-randomises its IV per
    // call, so two encryptions of the same value are never byte-equal. Masked sentinels
    // resolve against the stored value first, so an untouched secret compares equal.
    const stored = this.decryptRow(existing).settings as Record<string, unknown> | null;
    const incoming = resolveSettings('notifier', { ...(data.settings as Record<string, unknown>) }, stored ?? undefined);
    return stableStringify(incoming) !== stableStringify(stored);
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;

    await this.db.delete(notifiers).where(eq(notifiers.id, id));
    this.adapters.delete(id);
    // AUTOINCREMENT never reissues an id, so a recreated notifier cannot inherit this state.
    this.failures.clear(id);
    this.log.info({ id }, 'Notifier deleted');
    return true;
  }

  /** Isolate and log adapter failures across all matching enabled notifiers. */
  async notify(event: NotificationEvent, payload: EventPayload, options?: NotifyOptions): Promise<void> {
    const enabledNotifiers = await this.db
      .select()
      .from(notifiers)
      .where(eq(notifiers.enabled, true));

    const matching = enabledNotifiers.filter((n) => {
      // AC14: exclude at recipient selection, before the attempt gate, so a health
      // announcement about a notifier is never an attempt through it — it cannot commit an
      // outcome, and it cannot inflate that notifier's suppressedCount.
      if (options?.excludeNotifierId === n.id) return false;
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
        // Gate and reserve BEFORE the first await: a concurrent caller at a reopened gate
        // must fail its own check rather than double-send.
        if (!this.failures.reserveAttempt(notifier.id)) {
          this.log.debug(
            { notifier: notifier.name, notifierType: notifier.type, event, deliveryState: this.failures.get(notifier.id).state },
            'Notification suppressed',
          );
          return;
        }

        // An update or delete arriving mid-send invalidates this entry; the token lets the
        // late outcome be dropped rather than resurrecting state the operator just cleared.
        const generation = this.failures.generation(notifier.id);

        try {
          const adapter = this.getAdapter(notifier);
          const result = await adapter.send(event, payload);
          this.recordOutcome(notifier, event, result, generation);
        } catch (error: unknown) {
          this.commitFailure(notifier.id, describeTransportError(error), generation);
          this.log.warn({ notifier: notifier.name, notifierType: notifier.type, event, error: serializeError(error) }, 'Notification error');
        }
      }),
    );
  }

  private recordOutcome(notifier: NotifierRow, event: NotificationEvent, result: NotifierResult, generation: number): void {
    const context = { notifier: notifier.name, notifierType: notifier.type, event };

    if (result.success) {
      this.failures.recordSuccess(notifier.id, generation);
      this.log.debug(context, 'Notification sent');
      return;
    }

    const verdict = this.commitFailure(notifier.id, result.failure, generation);
    this.log.warn(
      { ...context, message: result.message, reason: verdict.reason },
      verdict.terminal ? 'Notification failed permanently — delivery stopped' : 'Notification failed',
    );
  }

  private commitFailure(id: number, failure: NotifierResult['failure'], generation: number) {
    const verdict = classifyFailure(failure);
    if (verdict.terminal) this.failures.recordTerminalFailure(id, verdict.reason, generation);
    else this.failures.recordTransientFailure(id, verdict.reason, generation);
    return verdict;
  }

  /**
   * The adapter result narrowed back to the route/client TestResult shape. The failure
   * descriptor is an internal classification input, not part of the v1 API surface.
   */
  private static toTestResult(result: NotifierResult): { success: boolean; message?: string } {
    return { success: result.success, ...(result.message !== undefined && { message: result.message }) };
  }

  async test(id: number): Promise<{ success: boolean; message?: string }> {
    const notifier = await this.getById(id);
    if (!notifier) {
      return { success: false, message: 'Notifier not found' };
    }

    try {
      const adapter = this.getAdapter(notifier);
      return NotifierService.toTestResult(await adapter.test());
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

      // Resolve edit sentinels against decrypted saved settings.
      let resolvedSettings = data.settings;
      if (data.id != null) {
        const existing = await this.getById(data.id);
        if (!existing) {
          return { success: false, message: 'Notifier not found' };
        }
        resolvedSettings = resolveSettings('notifier', data.settings, existing.settings as Record<string, unknown> | undefined);
      }

      const fakeRow = {
        id: 0, name: '', type: data.type, enabled: true,
        events: ['on_grab'], settings: resolvedSettings, createdAt: new Date(),
      } as NotifierRow;
      const adapter = this.createAdapter(fakeRow);
      const result = await adapter.test();
      this.log.debug({ type: data.type, success: result.success, message: result.message }, 'Notifier config test result');
      return NotifierService.toTestResult(result);
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  /** Accept raw or already-decrypted rows; decryption is idempotent on plaintext. */
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

    const settings = parseEntitySettings<NotifierSettings>(
      notifierSettingsSchemas,
      notifier.type,
      notifier.settings as Record<string, unknown>,
    );

    // Surface malformed headers that the factory otherwise ignores.
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
    this.failures.clearAll();
  }
}
