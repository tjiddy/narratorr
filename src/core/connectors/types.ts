import type { ConnectorType } from '../../shared/connector-registry.js';

export type { ConnectorType };

/** Settings field a connector failure can be attributed to (for field-scoped UI errors). */
export type ConnectorField = 'baseUrl' | 'apiKey' | 'libraryId';

/**
 * test() / target-route failure envelope — superset of the existing test-result
 * shape ({ success, message?, warning? }) plus field-scoped errors.
 */
export interface ConnectorTestResult {
  success: boolean;
  message?: string;
  warning?: string;
  // 401 -> apiKey, conn error -> baseUrl, bad libraryId -> libraryId
  fieldErrors?: Partial<Record<ConnectorField, string>>;
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
  // on transport/HTTP failure; NO internal retry.
  refreshImport(batch: ConnectorImportBatch): Promise<ConnectorRefreshResult>;
}
