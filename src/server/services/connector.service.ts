import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { connectors } from '../../db/schema.js';
import {
  ADAPTER_FACTORIES,
  ConnectorRequestError,
  requestWithRetry,
  type ConnectorAdapter,
  type ConnectorImportItem,
  type ConnectorReason,
  type ConnectorTarget,
  type ConnectorTestResult,
} from '../../core/connectors/index.js';
import { getErrorMessage } from '../utils/error-message.js';
import { connectorSettingsSchemas, type ConnectorSettings } from '../../shared/schemas/connector.js';
import { parseEntitySettings } from '../utils/parse-entity-settings.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey, getSecretFieldNames } from '../utils/secret-codec.js';
import { AdapterCache } from '../utils/adapter-cache.js';
import { serializeError } from '../utils/serialize-error.js';
import { CONNECTOR_TIMEOUT_MS } from '../../core/utils/constants.js';
import type { ConnectorRow } from './types.js';

type NewConnector = typeof connectors.$inferInsert;

/** Result of a targets lookup — a success carrying targets, or a field-scoped failure envelope. */
export type ConnectorTargetsResult =
  | { success: true; targets: ConnectorTarget[] }
  | (ConnectorTestResult & { success: false });

export interface ConnectorServiceOptions {
  /** Debounce window before a coalesced burst flushes (ms). */
  debounceMs?: number;
  /** Backoff before the single retry of a failed flush (ms). */
  backoffMs?: number;
  /** Outer per-attempt guard around refreshImport (ms). 0 disables the outer guard. */
  flushTimeoutMs?: number;
  /**
   * Hard cap on items in a pending batch. Reaching it flushes IMMEDIATELY
   * (without resetting the debounce timer) — bounds memory for path-scoped
   * providers (e.g. Plex) that consume every item.
   */
  maxBatchItems?: number;
  /**
   * Hard max-wait ceiling measured from the batch's FIRST enqueue. The per-item
   * debounce reset cannot push past it — a sustained burst still flushes here.
   */
  maxBatchWaitMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_BACKOFF_MS = 1_000;
// Outer service guard, longer than the adapter request timeout (F9 layering):
// fetchWithTimeout bounds each HTTP request; this only fires if an attempt hangs.
const DEFAULT_FLUSH_TIMEOUT_MS = CONNECTOR_TIMEOUT_MS + 5_000;
const DEFAULT_MAX_BATCH_ITEMS = 500;
const DEFAULT_MAX_BATCH_WAIT_MS = 30_000;

interface PendingFlush {
  connectorId: number;
  reason: ConnectorReason;
  items: ConnectorImportItem[];
  // Trailing quiet-period timer, reset on each enqueue.
  timer: ReturnType<typeof setTimeout>;
  // Non-resetting max-wait deadline timer, set once at first enqueue.
  deadlineTimer: ReturnType<typeof setTimeout>;
}

/**
 * Owns connector CRUD (encrypt-on-write / decrypt-on-read + adapter cache) AND
 * the shared refresh queue: debounce, single retry, timeout, and logging. The
 * adapters stay dumb transport — they issue one request and throw/return.
 *
 * Background flushes use THIS service's injected `Db` + `FastifyBaseLogger` (the
 * app-level singletons), never per-request objects — the deferred closure must
 * outlive the request that triggered it.
 */
export class ConnectorService {
  private adapters = new AdapterCache<ConnectorAdapter>();
  private pending = new Map<string, PendingFlush>();
  private readonly debounceMs: number;
  private readonly backoffMs: number;
  private readonly flushTimeoutMs: number;
  private readonly maxBatchItems: number;
  private readonly maxBatchWaitMs: number;

  constructor(private db: Db, private log: FastifyBaseLogger, opts: ConnectorServiceOptions = {}) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.maxBatchItems = opts.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS;
    this.maxBatchWaitMs = opts.maxBatchWaitMs ?? DEFAULT_MAX_BATCH_WAIT_MS;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────────────

  private decryptRow(row: ConnectorRow): ConnectorRow {
    if (!row.settings) return row;
    const s = { ...(row.settings as Record<string, unknown>) };
    return { ...row, settings: decryptFields('connector', s, getKey(), this.log) };
  }

  async getAll(): Promise<ConnectorRow[]> {
    const rows = await this.db.select().from(connectors);
    return rows.map((r) => this.decryptRow(r));
  }

  async getById(id: number): Promise<ConnectorRow | null> {
    const results = await this.db.select().from(connectors).where(eq(connectors.id, id)).limit(1);
    const row = results[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async create(data: Omit<NewConnector, 'id' | 'createdAt' | 'updatedAt'>): Promise<ConnectorRow> {
    const toInsert = { ...data };
    if (toInsert.settings) {
      toInsert.settings = encryptFields('connector', { ...(toInsert.settings as Record<string, unknown>) }, getKey());
    }
    const result = await this.db.insert(connectors).values(toInsert).returning();
    this.log.info({ name: data.name, type: data.type }, 'Connector created');
    return this.decryptRow(result[0]!);
  }

  async update(id: number, data: Partial<NewConnector>): Promise<ConnectorRow | null> {
    const toUpdate: Partial<NewConnector> = { ...data, updatedAt: new Date() };
    if (toUpdate.settings) {
      const settings = { ...(toUpdate.settings as Record<string, unknown>) };
      const existing = await this.db.select().from(connectors).where(eq(connectors.id, id)).limit(1);
      // Resolve sentinels against RAW (encrypted) existing settings — encryptFields
      // skips $ENC$-prefixed values, so unchanged secrets retain their stored bytes.
      resolveSentinelFields(settings, (existing[0]?.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('connector'));
      toUpdate.settings = encryptFields('connector', settings, getKey());
    }
    const result = await this.db.update(connectors).set(toUpdate).where(eq(connectors.id, id)).returning();

    // Drop the cached adapter so the next access re-instantiates with fresh settings.
    this.adapters.delete(id);
    this.log.info({ id }, 'Connector updated');
    const row = result[0] || null;
    return row ? this.decryptRow(row) : null;
  }

  async delete(id: number): Promise<boolean> {
    const existing = await this.getById(id);
    if (!existing) return false;
    await this.db.delete(connectors).where(eq(connectors.id, id));
    this.adapters.delete(id);
    this.log.info({ id }, 'Connector deleted');
    return true;
  }

  // ─── Adapter construction ────────────────────────────────────────────────────

  getAdapter(connector: ConnectorRow): ConnectorAdapter {
    let adapter = this.adapters.get(connector.id);
    if (!adapter) {
      const decrypted = this.decryptRow(connector);
      adapter = this.createAdapter(decrypted);
      this.adapters.set(connector.id, adapter);
    }
    return adapter;
  }

  private createAdapter(connector: ConnectorRow): ConnectorAdapter {
    const factory = ADAPTER_FACTORIES[connector.type];
    if (!factory) throw new Error(`Unknown connector type: ${connector.type}`);
    const settings = parseEntitySettings<ConnectorSettings>(
      connectorSettingsSchemas,
      connector.type,
      connector.settings as Record<string, unknown>,
    );
    return factory(settings);
  }

  clearAdapterCache(): void {
    this.adapters.clear();
  }

  // ─── Diagnostics: test + targets ─────────────────────────────────────────────

  async test(id: number): Promise<ConnectorTestResult> {
    const connector = await this.getById(id);
    if (!connector) return { success: false, message: 'Connector not found' };
    try {
      return await this.getAdapter(connector).test();
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
  }

  async testConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<ConnectorTestResult> {
    try {
      const adapter = await this.adapterForConfig(data);
      return await adapter.test();
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
  }

  async listTargets(id: number): Promise<ConnectorTargetsResult> {
    const connector = await this.getById(id);
    if (!connector) return { success: false, message: 'Connector not found' };
    return this.runTargets(() => this.getAdapter(connector).listTargets());
  }

  async listTargetsConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<ConnectorTargetsResult> {
    let adapter: ConnectorAdapter;
    try {
      adapter = await this.adapterForConfig(data);
    } catch (error: unknown) {
      return { success: false, message: getErrorMessage(error) };
    }
    return this.runTargets(() => adapter.listTargets());
  }

  private async runTargets(fn: () => Promise<ConnectorTarget[]>): Promise<ConnectorTargetsResult> {
    try {
      return { success: true, targets: await fn() };
    } catch (error: unknown) {
      if (error instanceof ConnectorRequestError) {
        return { success: false, message: error.message, ...(error.fieldErrors && { fieldErrors: error.fieldErrors }) };
      }
      return { success: false, message: getErrorMessage(error) };
    }
  }

  /** Build an adapter from an unsaved config, resolving secret sentinels against the saved row when an id is supplied. */
  private async adapterForConfig(data: { type: string; settings: Record<string, unknown>; id?: number }): Promise<ConnectorAdapter> {
    let resolvedSettings = data.settings;
    if (data.id != null) {
      const existing = await this.getById(data.id);
      if (!existing) throw new Error('Connector not found');
      resolvedSettings = { ...data.settings };
      resolveSentinelFields(resolvedSettings, (existing.settings ?? {}) as Record<string, unknown>, getSecretFieldNames('connector'));
    }
    const fakeRow = { id: 0, name: '', type: data.type, enabled: true, settings: resolvedSettings, createdAt: new Date(), updatedAt: new Date() } as ConnectorRow;
    return this.createAdapter(fakeRow);
  }

  // ─── Refresh queue ───────────────────────────────────────────────────────────

  /**
   * Fan out a refresh to every enabled connector. Synchronously enumerates
   * connectors (the pre-flight), then enqueues per (connector, reason). Caller
   * should invoke fire-and-forget — never await it in the import/rename/scan path.
   */
  async notifyRefresh(reason: ConnectorReason, items: ConnectorImportItem[]): Promise<void> {
    if (items.length === 0) return;
    const enabled = await this.db.select().from(connectors).where(eq(connectors.enabled, true));
    for (const connector of enabled) {
      for (const item of items) {
        this.enqueue(connector.id, reason, item);
      }
    }
  }

  /**
   * Add one item to the debounced batch for (connectorId, reason). Each distinct
   * reason has its own debounce window and produces its own single-reason batch.
   *
   * Upper bounds pre-empt the trailing debounce flush: reaching `maxBatchItems`
   * flushes immediately, and a `maxBatchWaitMs` deadline (set once at first
   * enqueue, never reset) caps how long a sustained burst can defer the flush.
   * Whichever condition fires first flushes the batch.
   */
  enqueue(connectorId: number, reason: ConnectorReason, item: ConnectorImportItem): void {
    const key = `${connectorId}:${reason}`;
    const existing = this.pending.get(key);
    if (existing) {
      existing.items.push(item);
      if (existing.items.length >= this.maxBatchItems) {
        // Cap reached: flush now (flush() clears both timers), do NOT reset debounce.
        void this.flush(key);
        return;
      }
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => { void this.flush(key); }, this.debounceMs);
      return;
    }
    const entry: PendingFlush = {
      connectorId,
      reason,
      items: [item],
      timer: setTimeout(() => { void this.flush(key); }, this.debounceMs),
      deadlineTimer: setTimeout(() => { void this.flush(key); }, this.maxBatchWaitMs),
    };
    this.pending.set(key, entry);
    // Edge: maxBatchItems === 1 means the first item already hits the cap.
    if (entry.items.length >= this.maxBatchItems) void this.flush(key);
  }

  private async flush(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    // Clear BOTH timers so the surviving one (the bound that didn't fire) can't
    // re-flush an already-deleted entry.
    clearTimeout(entry.timer);
    clearTimeout(entry.deadlineTimer);
    this.pending.delete(key);

    const connector = await this.getById(entry.connectorId);
    if (!connector || !connector.enabled) return;

    const adapter = this.getAdapter(connector);
    const batch = { reason: entry.reason, items: entry.items };
    const logCtx = { connectorId: connector.id, connectorType: connector.type, reason: entry.reason, count: entry.items.length };
    try {
      // Capture the result: a resolved { success: false } is a completed-but-
      // rejected provider response (non-retryable) and must NOT read as a
      // successful dispatch; a success message (e.g. Plex skip counts) is logged.
      const result = await requestWithRetry(
        () => this.withTimeout((signal) => adapter.refreshImport(batch, signal)),
        {
          maxRetries: 1,
          delayMs: this.backoffMs,
          shouldRetry: (e) => e instanceof ConnectorRequestError && e.retryable,
        },
      );
      if (!result.success) {
        this.log.warn({ ...logCtx, message: result.message }, 'Connector refresh rejected');
      } else if (result.message) {
        this.log.info({ ...logCtx, message: result.message }, 'Connector refresh dispatched');
      } else {
        this.log.debug(logCtx, 'Connector refresh dispatched');
      }
    } catch (error: unknown) {
      this.log.warn(
        {
          connectorId: connector.id,
          connectorType: connector.type,
          connectorName: connector.name,
          url: redactBaseUrl(connector.settings),
          error: serializeError(error),
        },
        'Connector refresh failed',
      );
    }
  }

  /**
   * Run `fn` under an outer per-attempt guard. Threads a real AbortSignal into
   * `fn` and ABORTS it when the timeout fires — so an adapter that fans out
   * fetches (Plex) actually cancels in-flight work rather than leaving it racing
   * (the prior Promise.race could not stop already-started work). 0 disables the
   * timeout; the signal is still passed (never aborts).
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    if (this.flushTimeoutMs <= 0) return fn(controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ConnectorRequestError('Connector refresh timed out', { retryable: true }));
      }, this.flushTimeoutMs);
    });
    try {
      return await Promise.race([fn(controller.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Extract a host-only (credential-free) form of the connector base URL for logging. */
function redactBaseUrl(settings: unknown): string {
  const raw = (settings as Record<string, unknown> | null)?.baseUrl;
  if (typeof raw !== 'string' || !raw) return '[unknown]';
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[unparseable]';
  }
}
