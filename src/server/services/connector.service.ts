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
  type ConnectorRefreshResult,
  type ConnectorTarget,
  type ConnectorTestResult,
} from '../../core/connectors/index.js';
import { getErrorMessage } from '../utils/error-message.js';
import { connectorSettingsSchemas, type ConnectorSettings } from '../../shared/schemas/connector.js';
import { parseEntitySettings } from '../utils/parse-entity-settings.js';
import { encryptFields, decryptFields, resolveSentinelFields, getKey, getSecretFieldNames } from '../utils/secret-codec.js';
import { AdapterCache } from '../utils/adapter-cache.js';
import { serializeError } from '../utils/serialize-error.js';
import { CONNECTOR_TIMEOUT_MS, CONNECTOR_SHUTDOWN_DRAIN_MS } from '../../core/utils/constants.js';
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
  /**
   * Hard cap on how long `stop()` waits for in-flight flushes to drain on
   * shutdown (ms). Defaults to `CONNECTOR_SHUTDOWN_DRAIN_MS`. Injectable so tests
   * can use a tiny budget; production always uses the constant.
   */
  shutdownDrainMs?: number;
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
  // Every reason coalesced into this entry, deduplicated and first-seen order-stable.
  // The pending key is the connector id alone, so a mixed-reason burst (import +
  // restored during a bulk run) accumulates here as ONE entry → one provider refresh,
  // instead of splitting into a separate single-reason flush per reason.
  reasons: ConnectorReason[];
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
  // BEST-EFFORT, IN-MEMORY refresh queue. Pending work lives only as setTimeout
  // timers in this Map — there is no durable/persistent backing. `stop()` drains
  // in-flight flushes on graceful shutdown, but a hard crash (SIGKILL/OOM) or a
  // refresh still inside its debounce window is dropped by design. The downstream
  // media server (ABS/Plex) reconciles on its own next library change or periodic
  // scan, so a lost refresh is self-healing — a durable queue would be
  // over-engineering for a self-hosted single-process app (see #769/#877/#885).
  private pending = new Map<string, PendingFlush>();
  // Set by stop() so any post-shutdown enqueue() is a no-op (mirrors
  // ImportQueueWorker's `stopping` flag).
  private stopping = false;
  // Per-connector-id tail of the in-flight flush chain. Serializes flushes for
  // the SAME connector (a cap-triggered flush chains behind any in-flight one)
  // while keeping DIFFERENT connector ids fully parallel. Keyed by connectorId —
  // the same dimension the pending queue now debounces on, so a connector's
  // coalesced mixed-reason batch serializes against its own follow-up flushes.
  private draining = new Map<number, Promise<void>>();
  // Aborted by stop() when the shutdown drain budget expires. Composed into every
  // in-flight attempt's signal (see withTimeout) and threaded into requestWithRetry
  // so the awaiting request AND any pending retry/backoff unwind at the deadline —
  // a deadline abort is terminal (non-retryable), unlike a scaled-timeout abort.
  private readonly shutdownSignal = new AbortController();
  // Memoizes the stop() drain so a second call is a true no-op (returns the same
  // promise) and never re-runs the pending-drop / deadline-warn path.
  private stopPromise?: Promise<void>;
  private readonly debounceMs: number;
  private readonly backoffMs: number;
  private readonly flushTimeoutMs: number;
  private readonly maxBatchItems: number;
  private readonly maxBatchWaitMs: number;
  private readonly shutdownDrainMs: number;

  constructor(private db: Db, private log: FastifyBaseLogger, opts: ConnectorServiceOptions = {}) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.maxBatchItems = opts.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS;
    this.maxBatchWaitMs = opts.maxBatchWaitMs ?? DEFAULT_MAX_BATCH_WAIT_MS;
    this.shutdownDrainMs = opts.shutdownDrainMs ?? CONNECTOR_SHUTDOWN_DRAIN_MS;
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
   * connectors (the pre-flight), then enqueues each item under its connector's
   * single debounce window. Caller should invoke fire-and-forget — never await it
   * in the import/rename/scan path.
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
   * Add one item to the debounced batch for `connectorId`. The debounce key is the
   * connector id ALONE — distinct reasons for the same connector coalesce into one
   * window and flush as a single batch carrying the union of items and the set of
   * reasons. ABS issues one full-library scan regardless of reason, so this collapses
   * what used to be one redundant scan per reason during mixed bursts (import +
   * rename/restored) into one.
   *
   * Upper bounds pre-empt the trailing debounce flush: reaching `maxBatchItems`
   * flushes immediately, and a `maxBatchWaitMs` deadline (set once at first
   * enqueue, never reset) caps how long a sustained burst can defer the flush.
   * Whichever condition fires first flushes the batch.
   */
  enqueue(connectorId: number, reason: ConnectorReason, item: ConnectorImportItem): void {
    // Post-stop enqueues are dropped: shutdown is in progress and there is no
    // future flush to schedule. Best-effort semantics — see the `pending` comment.
    if (this.stopping) return;
    const key = String(connectorId);
    const existing = this.pending.get(key);
    if (existing) {
      existing.items.push(item);
      // Track the reason on the coalesced entry — deduplicated, first-seen order-stable.
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (existing.items.length >= this.maxBatchItems) {
        // Cap reached: flush now (flush() clears both timers), do NOT reset debounce.
        void this.flush(key);
        return;
      }
      clearTimeout(existing.timer);
      existing.timer = this.armTimer(() => { void this.flush(key); }, this.debounceMs);
      return;
    }
    const entry: PendingFlush = {
      connectorId,
      reasons: [reason],
      items: [item],
      timer: this.armTimer(() => { void this.flush(key); }, this.debounceMs),
      deadlineTimer: this.armTimer(() => { void this.flush(key); }, this.maxBatchWaitMs),
    };
    this.pending.set(key, entry);
    // Edge: maxBatchItems === 1 means the first item already hits the cap.
    if (entry.items.length >= this.maxBatchItems) void this.flush(key);
  }

  /**
   * Create a queue timer that does NOT keep the event loop alive. Every
   * refresh-queue `setTimeout` (debounce, deadline, and the request-timeout
   * watchdog in `withTimeout`) is armed through here so a pending timer can't
   * delay graceful shutdown past SIGTERM — `stop()` clears or awaits the work,
   * the timer itself must never be the thing holding the process open.
   */
  private armTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  }

  /**
   * BOUNDED graceful drain for shutdown (mirrors `ImportQueueWorker.stop()`):
   *  1. set the stopping flag so any further `enqueue()` is a no-op AND any
   *     chained (not-yet-started) draining tail short-circuits in `executeFlush`,
   *  2. clear all pending debounce + deadline timers and DROP their batches —
   *     warn-logging each so a lost refresh is visible (connector id + count),
   *  3. race the in-flight `draining` flushes against `shutdownDrainMs`: a flush
   *     mid-request OR mid-retry-backoff that settles inside the budget drains
   *     normally; at the deadline the shutdown signal is aborted (cancelling the
   *     awaiting request + any pending backoff) and the still-draining connectors
   *     are warn-logged as dropped.
   *
   * This bounds stop() — and therefore the whole graceful-shutdown sequence — to
   * `shutdownDrainMs` regardless of the scaled per-attempt `withTimeout` budget,
   * which can otherwise run to minutes for a large multi-path Plex batch (#1512).
   *
   * Never throws: `executeFlush` already absorbs its own errors, and the in-flight
   * await uses `Promise.allSettled` so a failing flush can't reject shutdown.
   * Idempotent — memoized, so a second call returns the same promise and never
   * re-drops pending or re-warns the deadline.
   */
  async stop(): Promise<void> {
    this.stopPromise ??= this.runStop();
    return this.stopPromise;
  }

  private async runStop(): Promise<void> {
    this.stopping = true;

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.deadlineTimer);
      this.log.warn(
        { connectorId: entry.connectorId, reasons: entry.reasons, count: entry.items.length },
        'Connector refresh dropped on shutdown',
      );
    }
    this.pending.clear();

    const inFlight = [...this.draining.values()];
    if (inFlight.length === 0) return;

    this.log.info({ count: inFlight.length }, 'Awaiting in-flight connector refreshes before shutdown…');
    await this.drainInFlight(inFlight);
  }

  /**
   * Race the in-flight flushes against the shutdown drain budget. On a clean drain
   * (all settle first) returns quietly; on deadline expiry it aborts in-flight
   * attempts (so the awaiting requests + backoff sleeps unwind promptly) and warns
   * about whatever connector ids are still draining. `draining` self-prunes via
   * each flush's `.finally`, so its remaining keys at the deadline ARE the set
   * that failed to drain in time.
   */
  private async drainInFlight(inFlight: Promise<void>[]): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = this.armTimer(() => resolve('deadline'), this.shutdownDrainMs);
    });
    const drained = Promise.allSettled(inFlight).then(() => 'drained' as const);
    const outcome = await Promise.race([drained, deadline]);
    if (timer) clearTimeout(timer);
    if (outcome === 'drained') return;

    this.shutdownSignal.abort();
    const dropped = [...this.draining.keys()];
    this.log.warn(
      { connectorIds: dropped, count: dropped.length },
      'Connector refreshes dropped at shutdown drain deadline',
    );
  }

  /**
   * Dequeue the pending batch for `key` and run it — but SERIALIZED per connector
   * id. `flush()` itself is synchronous: it detaches the batch (clears timers,
   * deletes the pending entry) and chains the actual adapter work behind any
   * in-flight flush for the SAME connector. This closes the cap-burst race: a
   * cap-triggered flush deletes its pending entry BEFORE awaiting adapter work, so
   * a synchronous >maxBatchItems burst can create a fresh pending entry for the
   * same connector while the first flush is still running — without this chain the
   * two flushes would run concurrent `refreshImport` calls (and concurrent
   * sequential path loops) against one provider. Chaining (not a global lock)
   * leaves DIFFERENT connector ids fully parallel.
   */
  private flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    // Clear BOTH timers so the surviving one (the bound that didn't fire) can't
    // re-flush an already-deleted entry.
    clearTimeout(entry.timer);
    clearTimeout(entry.deadlineTimer);
    this.pending.delete(key);

    // executeFlush() never rejects (full try/catch), so the chain stays resolved
    // and a failing flush can't break serialization for the next batch.
    const prior = this.draining.get(entry.connectorId) ?? Promise.resolve();
    const next = prior.then(() => this.executeFlush(entry));
    this.draining.set(entry.connectorId, next);
    // Drop the chain tail once it settles — but only if a later flush hasn't
    // already extended it (else we'd delete a still-pending tail and lose
    // serialization for the rest of the burst).
    void next.finally(() => {
      if (this.draining.get(entry.connectorId) === next) this.draining.delete(entry.connectorId);
    });
  }

  private async executeFlush(entry: PendingFlush): Promise<void> {
    // A chained tail (queued behind an active flush via flush()'s
    // `prior.then(() => executeFlush(entry))`) must NOT start fresh connector work
    // once shutdown has begun: when the active attempt unwinds, this continuation
    // would otherwise call getById + refreshImport and begin a brand-new request
    // after stop() has resolved. Short-circuit BEFORE any adapter call and warn-log
    // the drop. The chain's `.finally` still cleans the draining entry.
    if (this.stopping) {
      this.log.warn(
        { connectorId: entry.connectorId, reasons: entry.reasons, count: entry.items.length },
        'Connector refresh dropped on shutdown',
      );
      return;
    }
    // The connector resolve + adapter build live INSIDE the try so a drifted
    // settings row (ZodError), an unknown connector type, or a getById DB error
    // folds into the warn-log path instead of escaping this detached flush as an
    // unhandled rejection (which the global handler turns into process.exit(1)).
    let connector: ConnectorRow | null = null;
    try {
      connector = await this.getById(entry.connectorId);
      if (!connector || !connector.enabled) return;

      const adapter = this.getAdapter(connector);
      const batch = { reasons: entry.reasons, items: entry.items };
      // The redacted host disambiguates same-type connectors at 3am — carry it on
      // every success branch (dispatched/rejected), not just the catch path. `reasons`
      // carries the full coalesced set so dispatch/rejected/ineffective logs never
      // imply a single reason that hides what was merged into this batch.
      const logCtx = { connectorId: connector.id, connectorType: connector.type, reasons: entry.reasons, count: entry.items.length, url: redactBaseUrl(connector.settings) };
      // Scale the outer watchdog to how many sequential requests this batch will
      // make so a multi-request provider (Plex) is not aborted mid-flush.
      const requestCount = Math.max(1, adapter.estimateRequestCount(batch));
      // Capture the result: a resolved { success: false } is a completed-but-
      // rejected provider response (non-retryable) and must NOT read as a
      // successful dispatch; a success message (e.g. Plex skip counts) is logged.
      const result = await requestWithRetry(
        () => this.withTimeout((signal) => adapter.refreshImport(batch, signal), requestCount),
        {
          maxRetries: 1,
          delayMs: this.backoffMs,
          shouldRetry: (e) => e instanceof ConnectorRequestError && e.retryable,
          // The shutdown deadline aborts this signal; requestWithRetry then refuses
          // a second attempt and interrupts any pending backoff (a deadline abort
          // is terminal, NOT a retryable timeout).
          signal: this.shutdownSignal.signal,
        },
      );
      this.logFlushResult(logCtx, result);
    } catch (error: unknown) {
      // A shutdown-deadline abort already warn-logs the dropped connector set in
      // drainInFlight(); don't double-log the resulting rejection as a generic
      // failure (it's an intentional cancellation, not a provider error).
      if (this.shutdownSignal.signal.aborted) return;
      // `connector` may still be null when the failure originated in getById /
      // getAdapter — degrade to the queue entry's connectorId rather than
      // dereferencing it and throwing a second time inside the catch.
      this.log.warn(
        {
          connectorId: connector?.id ?? entry.connectorId,
          connectorType: connector?.type,
          connectorName: connector?.name,
          reasons: entry.reasons,
          count: entry.items.length,
          url: connector ? redactBaseUrl(connector.settings) : undefined,
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
   *
   * The budget is MULTI-REQUEST-AWARE: `flushTimeoutMs` budgets ONE request plus
   * margin (the historical default is `CONNECTOR_TIMEOUT_MS + 5s`), and each
   * ADDITIONAL sequential request the adapter reports via `requestCount` (Plex
   * issues one per distinct server path, sequentially) adds a full
   * `CONNECTOR_TIMEOUT_MS`. Prior reviewers rated the flat single-request budget
   * "correct" — and it IS, but only for single-request adapters: at
   * requestCount === 1 the budget is identical to before, so ABS is unchanged.
   * Without this scaling a healthy Plex batch whose cumulative (yet individually
   * in-budget) request time exceeds ~20s tripped the outer abort and logged a
   * spurious failure. `fetchWithTimeout` still bounds each individual HTTP request
   * inside the adapter; this watchdog only fires if a whole attempt hangs past its
   * scaled budget.
   */
  /**
   * Log a completed flush at the level dictated by its STRUCTURED result fields —
   * never by parsing `message`. `skipped`/`passthrough` are silently-ineffective
   * outcomes (no-derivable items left unrefreshed; paths sent unchanged against a
   * remapped server) the operator must see → warn. `fallbackRefreshed` does NOT
   * warn — those items were rescued by the section refresh. `?? 0` guards the
   * falsy-coercion trap: a present 0 must not read as "warn". The resolved server
   * paths are emitted at debug as the explicit replay handoff — no re-derivation.
   */
  private logFlushResult(logCtx: Record<string, unknown>, result: ConnectorRefreshResult): void {
    const ineffective = (result.skipped ?? 0) > 0 || (result.passthrough ?? 0) > 0;
    if (!result.success) {
      this.log.warn({ ...logCtx, message: result.message }, 'Connector refresh rejected');
    } else if (ineffective) {
      this.log.warn({ ...logCtx, message: result.message }, 'Connector refresh ineffective');
    } else if (result.message) {
      this.log.info({ ...logCtx, message: result.message }, 'Connector refresh dispatched');
    } else {
      this.log.debug(logCtx, 'Connector refresh dispatched');
    }
    if (result.resolvedServerPaths?.length) {
      this.log.debug({ ...logCtx, resolvedServerPaths: result.resolvedServerPaths }, 'Connector resolved server paths');
    }
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, requestCount: number): Promise<T> {
    const controller = new AbortController();
    // Compose the per-attempt timeout controller with the service shutdown signal:
    // EITHER the scaled-budget timeout OR a shutdown-drain-deadline abort cancels
    // the in-flight adapter request. Composed even when the outer timeout is
    // disabled so a shutdown abort still reaches the request.
    const signal = AbortSignal.any([controller.signal, this.shutdownSignal.signal]);
    if (this.flushTimeoutMs <= 0) return fn(signal);
    const budgetMs = this.flushTimeoutMs + Math.max(0, requestCount - 1) * CONNECTOR_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.armTimer(() => {
        controller.abort();
        reject(new ConnectorRequestError('Connector refresh timed out', { retryable: true }));
      }, budgetMs);
    });
    try {
      return await Promise.race([fn(signal), timeout]);
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
