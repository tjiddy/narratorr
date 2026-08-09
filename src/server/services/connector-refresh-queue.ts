import type { FastifyBaseLogger } from 'fastify';
import {
  ConnectorRequestError,
  requestWithRetry,
  type ConnectorImportItem,
  type ConnectorReason,
  type ConnectorRefreshResult,
} from '@core/connectors/index.js';
import { serializeError } from '../utils/serialize-error.js';
import { CONNECTOR_TIMEOUT_MS, CONNECTOR_SHUTDOWN_DRAIN_MS } from '@core/utils/constants.js';

export interface ConnectorRefreshQueueOptions {
  debounceMs?: number;
  backoffMs?: number;
  /** Outer per-attempt guard in milliseconds; 0 disables it. */
  flushTimeoutMs?: number;
  /** Flush immediately at this pending-item cap. */
  maxBatchItems?: number;
  /** Max wait from the first enqueue; debounce resets cannot extend it. */
  maxBatchWaitMs?: number;
  /** Hard cap in milliseconds for `stop()` to drain in-flight flushes. */
  shutdownDrainMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_BACKOFF_MS = 1_000;
// Adapter requests have their own timeout; this guard catches a hung whole attempt.
const DEFAULT_FLUSH_TIMEOUT_MS = CONNECTOR_TIMEOUT_MS + 5_000;
const DEFAULT_MAX_BATCH_ITEMS = 500;
const DEFAULT_MAX_BATCH_WAIT_MS = 30_000;

export interface PendingFlush {
  connectorId: number;
  reasons: ConnectorReason[];
  items: ConnectorImportItem[];
  // Reset on each enqueue.
  timer: ReturnType<typeof setTimeout>;
  // Fixed from the first enqueue.
  deadlineTimer: ReturnType<typeof setTimeout>;
}

/** Row-derived log fields supplied by the resolver; the queue has no row access. */
export interface ConnectorLogContext {
  connectorId: number;
  connectorType: string;
  connectorName: string;
  /** Host-only and credential-free. */
  url: string;
}

/**
 * Resolved at flush time through the queue's only connector/adapter/DB seam.
 * Returning null skips a disabled or missing connector.
 */
export interface ResolvedFlush {
  // adapter.estimateRequestCount(batch) scales the queue's withTimeout budget.
  requestCount: number;
  logContext: ConnectorLogContext;
  // The queue aborts this signal on attempt timeout or shutdown.
  run: (signal: AbortSignal) => Promise<ConnectorRefreshResult>;
}

export type ResolveFlush = (entry: PendingFlush) => Promise<ResolvedFlush | null>;

/** Preserves row context when resolution fails after lookup, keeping failure logs attributable. */
export class FlushResolutionError extends Error {
  constructor(readonly logContext: ConnectorLogContext, readonly cause: unknown) {
    super('Connector flush resolution failed');
    this.name = 'FlushResolutionError';
  }
}

/**
 * Best-effort in-memory queue with coalescing, per-connector serialization, one
 * retry, scaled timeouts, and bounded shutdown drain. Debounced work is lost on a
 * hard crash or shutdown; downstream periodic scans self-heal. Connector and DB
 * state enters only through `resolveFlush`.
 */
export class ConnectorRefreshQueue {
  private pending = new Map<string, PendingFlush>();
  private stopping = false;
  // Per-connector chain tails serialize one connector while leaving others parallel.
  private draining = new Map<number, Promise<void>>();
  // The shutdown deadline aborts active requests and retry backoffs terminally.
  private readonly shutdownSignal = new AbortController();
  private stopPromise?: Promise<void>;
  private readonly debounceMs: number;
  private readonly backoffMs: number;
  private readonly flushTimeoutMs: number;
  private readonly maxBatchItems: number;
  private readonly maxBatchWaitMs: number;
  private readonly shutdownDrainMs: number;

  constructor(
    private readonly resolveFlush: ResolveFlush,
    private readonly log: FastifyBaseLogger,
    opts: ConnectorRefreshQueueOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this.maxBatchItems = opts.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS;
    this.maxBatchWaitMs = opts.maxBatchWaitMs ?? DEFAULT_MAX_BATCH_WAIT_MS;
    this.shutdownDrainMs = opts.shutdownDrainMs ?? CONNECTOR_SHUTDOWN_DRAIN_MS;
  }

  /**
   * Coalesces items and first-seen reasons by connector id alone. The quiet-period
   * debounce resets per item; batch size and first-enqueue deadlines pre-empt it.
   */
  enqueue(connectorId: number, reason: ConnectorReason, item: ConnectorImportItem): void {
    if (this.stopping) return;
    const key = String(connectorId);
    const existing = this.pending.get(key);
    if (existing) {
      existing.items.push(item);
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (existing.items.length >= this.maxBatchItems) {
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
    if (entry.items.length >= this.maxBatchItems) void this.flush(key);
  }

  // Queue timers are unref'd so debounce and watchdog deadlines cannot hold the process open.
  private armTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  }

  /**
   * Idempotent bounded shutdown: reject new work, drop and log debounced batches,
   * then drain in-flight chains until the deadline aborts requests and retry sleeps.
   * Never rejects.
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

  // At deadline, the self-pruned draining keys are precisely the connectors still in flight.
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
   * Detaches the batch synchronously, then chains it behind the same connector's
   * tail. This serializes cap-created follow-up batches without blocking others.
   */
  private flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    // Clear the non-firing bound too, or it will re-flush the detached entry.
    clearTimeout(entry.timer);
    clearTimeout(entry.deadlineTimer);
    this.pending.delete(key);

    // executeFlush absorbs errors, keeping the serialization chain usable.
    const prior = this.draining.get(entry.connectorId) ?? Promise.resolve();
    const next = prior.then(() => this.executeFlush(entry));
    this.draining.set(entry.connectorId, next);
    // Delete only this tail; a later batch may already have extended the chain.
    void next.finally(() => {
      if (this.draining.get(entry.connectorId) === next) this.draining.delete(entry.connectorId);
    });
  }

  private async executeFlush(entry: PendingFlush): Promise<void> {
    // A tail queued before stop may not start new work after its predecessor unwinds.
    if (this.stopping) {
      this.log.warn(
        { connectorId: entry.connectorId, reasons: entry.reasons, count: entry.items.length },
        'Connector refresh dropped on shutdown',
      );
      return;
    }
    // Keep resolution failures inside this detached task; unhandled rejection exits the process.
    let resolved: ResolvedFlush | null;
    try {
      resolved = await this.resolveFlush(entry);
    } catch (error: unknown) {
      // drainInFlight already logs shutdown aborts.
      if (this.shutdownSignal.signal.aborted) return;
      const ctx = error instanceof FlushResolutionError ? error.logContext : undefined;
      const cause = error instanceof FlushResolutionError ? error.cause : error;
      this.logFailure(entry, ctx, cause);
      return;
    }
    if (!resolved) return;
    const flush = resolved;
    try {
      const result = await requestWithRetry(
        () => this.withTimeout(flush.run, flush.requestCount),
        {
          maxRetries: 1,
          delayMs: this.backoffMs,
          shouldRetry: (e) => e instanceof ConnectorRequestError && e.retryable,
          // Shutdown aborts are terminal and interrupt pending retry backoff.
          signal: this.shutdownSignal.signal,
        },
      );
      this.logFlushResult(this.successLogContext(flush.logContext, entry), result);
    } catch (error: unknown) {
      // drainInFlight already logs shutdown aborts.
      if (this.shutdownSignal.signal.aborted) return;
      this.logFailure(entry, flush.logContext, error);
    }
  }

  // Success logs omit connectorName but retain the redacted URL and every coalesced reason.
  private successLogContext(ctx: ConnectorLogContext, entry: PendingFlush): Record<string, unknown> {
    return { connectorId: ctx.connectorId, connectorType: ctx.connectorType, reasons: entry.reasons, count: entry.items.length, url: ctx.url };
  }

  private logFailure(entry: PendingFlush, ctx: ConnectorLogContext | undefined, error: unknown): void {
    this.log.warn(
      {
        connectorId: ctx?.connectorId ?? entry.connectorId,
        connectorType: ctx?.connectorType,
        connectorName: ctx?.connectorName,
        reasons: entry.reasons,
        count: entry.items.length,
        url: ctx?.url,
        error: serializeError(error),
      },
      'Connector refresh failed',
    );
  }

  /**
   * Derive level from structured fields, never message text: failed or
   * skipped/passthrough outcomes warn, while fallback-refreshed items succeeded.
   * Emit resolved paths verbatim at debug for replay.
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

  /**
   * Abort a whole attempt after one base budget plus `CONNECTOR_TIMEOUT_MS` per
   * additional sequential request. Adapter timeouts still bound each fetch; 0
   * disables only this outer guard.
   */
  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, requestCount: number): Promise<T> {
    const controller = new AbortController();
    // Compose shutdown even when the outer timeout is disabled.
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
