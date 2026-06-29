import type { ConnectorType } from '../../shared/connector-registry.js';

export type { ConnectorType };

/**
 * Field-scoped error map keyed by a provider settings key (e.g. `baseUrl`,
 * `apiKey`, `token`, `libraryId`, `sectionId`). Registry-driven: each connector
 * declares its own settings keys (`settingsFields`), so the map is an open
 * `Record<string, string>` rather than a closed ABS-only union — the form routes
 * an error to the matching input by `settingsFields[].key`, and unknown keys fall
 * back to a form-level error.
 */
export type ConnectorFieldErrors = Record<string, string>;

/**
 * test() / target-route failure envelope — superset of the existing test-result
 * shape ({ success, message?, warning? }) plus field-scoped errors.
 */
export interface ConnectorTestResult {
  success: boolean;
  message?: string;
  warning?: string;
  // e.g. 401 -> token/apiKey, conn error -> baseUrl, bad section -> sectionId
  fieldErrors?: ConnectorFieldErrors;
}

/** A provider-side library/section the connector can target. */
export interface ConnectorTarget {
  id: string;   // provider-side library/section id
  name: string; // human label for the dropdown
}

export interface ConnectorRefreshResult {
  // success: true on a completed scan request. success: false is reserved for a
  // completed-but-rejected provider response (definitively NON-retryable).
  success: boolean;
  message?: string;
  // Structured outcome counts for path-scoped providers (Plex). All optional so
  // single-request adapters (ABS) need no change. The service decides the log
  // LEVEL from these counts — never by parsing `message`.
  /** No-derivable-path items left UNREFRESHED (fallback OFF). A silent no-op the operator must see → warn. */
  skipped?: number;
  /** Items sent to the server UNCHANGED because no mapping matched. Effective no-op against a remapped server → warn. */
  passthrough?: number;
  /** No-derivable-path items RESCUED by the section-wide full refresh (fallback ON). Does NOT warn — they were refreshed. */
  fallbackRefreshed?: number;
  /** The distinct server paths the adapter actually requested this flush — the explicit handoff the service debug-logs. */
  resolvedServerPaths?: string[];
}

/**
 * Why a refresh was enqueued. A coalesced batch may carry several (see queue grouping).
 *
 * The reason is observability-only — ABS issues a full-library scan regardless and Plex
 * derives the paths to refresh from `items` — so adding a literal here never changes adapter
 * behaviour. `merge`/`convert`/`metadata` cover the post-import file mutations (audio swap,
 * OPF/cover sidecar writes, re-tag) that also change media-server-visible files.
 */
export type ConnectorReason = 'import' | 'adopt' | 'rename' | 'restored' | 'merge' | 'convert' | 'metadata';

export interface ConnectorImportItem {
  bookId: number;
  title: string;
  authorName?: string | null;
  libraryPath: string;          // narratorr-side final path
  serverPath?: string | null;   // provider-side path after connector path mapping
}

export interface ConnectorImportBatch {
  // All reasons coalesced into this batch, deduplicated and first-seen order-stable.
  // The queue debounces per connector id (NOT per reason), so a single window can
  // merge e.g. an `import` and a `restored`; every contributing reason is preserved
  // here rather than collapsed to a scalar that would hide what was merged. No shipped
  // adapter inspects it (ABS does a full-library scan; Plex derives paths from `items`).
  reasons: ConnectorReason[];
  items: ConnectorImportItem[];
}

export interface ConnectorAdapter {
  readonly type: ConnectorType;
  // Diagnostic action: never throws for expected auth/conn failures — catches
  // internally and returns a field-scoped result.
  test(): Promise<ConnectorTestResult>;
  // Returns targets on success; THROWS ConnectorRequestError (with fieldErrors)
  // on auth/connection failure.
  listTargets(): Promise<ConnectorTarget[]>;
  // Returns { success: true } on a completed scan; THROWS ConnectorRequestError
  // on transport/HTTP failure; NO internal retry. The service threads a real
  // AbortSignal (fired by the outer flush timeout) so providers that fan out
  // per-path fetches (e.g. Plex) can abort in-flight requests on timeout. A
  // resolved { success: false } is reserved for a completed-but-rejected provider
  // response (definitively NON-retryable) — transport/HTTP failures THROW.
  refreshImport(batch: ConnectorImportBatch, signal: AbortSignal): Promise<ConnectorRefreshResult>;
  /**
   * How many SEQUENTIAL outbound requests refreshImport() will make for this
   * batch. The service scales its outer flush-timeout watchdog by this count so a
   * multi-request provider is not aborted mid-batch when the cumulative — but
   * individually in-budget — request time exceeds a single-request budget. A
   * single-request provider (ABS: one library scan regardless of batch contents)
   * returns 1; a path-scoped provider (Plex: one targeted refresh per distinct
   * derivable server path, plus an optional section-wide fallback) returns its
   * derivable request count. Must mirror the request plan refreshImport() actually
   * executes, and must NOT perform I/O (pure, synchronous estimate).
   */
  estimateRequestCount(batch: ConnectorImportBatch): number;
}
