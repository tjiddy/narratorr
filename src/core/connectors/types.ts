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
}

/** Why a refresh was enqueued. Exactly one reason per batch (see queue grouping). */
export type ConnectorReason = 'import' | 'adopt' | 'rename' | 'restored';

export interface ConnectorImportItem {
  bookId: number;
  title: string;
  authorName?: string | null;
  libraryPath: string;          // narratorr-side final path
  serverPath?: string | null;   // provider-side path after connector path mapping
}

export interface ConnectorImportBatch {
  reason: ConnectorReason;
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
}
