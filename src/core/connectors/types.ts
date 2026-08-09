import type { ConnectorType } from '@shared/connector-registry.js';

export type { ConnectorType };

// Keys come from each connector's registry fields; unknown keys render as form errors.
export type ConnectorFieldErrors = Record<string, string>;

export interface ConnectorTestResult {
  success: boolean;
  message?: string;
  warning?: string;
  fieldErrors?: ConnectorFieldErrors;
}

export interface ConnectorTarget {
  id: string;
  name: string;
}

export interface ConnectorRefreshResult {
  // false is reserved for completed, non-retryable provider rejections.
  success: boolean;
  message?: string;
  /** No-derivable-path items left unrefreshed. */
  skipped?: number;
  /** Items sent unchanged because no mapping matched. */
  passthrough?: number;
  /** No-derivable-path items covered by a full refresh. */
  fallbackRefreshed?: number;
  /** Distinct server paths actually requested. */
  resolvedServerPaths?: string[];
}

// Reasons are observability-only; adapters derive work from items. merge/metadata cover
// post-import mutations that change media-server-visible files.
export type ConnectorReason = 'import' | 'adopt' | 'rename' | 'restored' | 'merge' | 'metadata';

export interface ConnectorImportItem {
  bookId: number;
  title: string;
  authorName?: string | null;
  libraryPath: string;
  serverPath?: string | null;
}

export interface ConnectorImportBatch {
  // All coalesced reasons, deduplicated in first-seen order.
  reasons: ConnectorReason[];
  items: ConnectorImportItem[];
}

export interface ConnectorAdapter {
  readonly type: ConnectorType;
  // Expected auth/connection failures become field-scoped results.
  test(): Promise<ConnectorTestResult>;
  // Auth/connection failures throw ConnectorRequestError with fieldErrors.
  listTargets(): Promise<ConnectorTarget[]>;
  // Transport/HTTP failures throw without internal retry. The service signal cancels
  // fan-out on its outer timeout; false is reserved for completed provider rejections.
  refreshImport(batch: ConnectorImportBatch, signal: AbortSignal): Promise<ConnectorRefreshResult>;
  /** Pure count of sequential requests; must mirror refreshImport's request plan. */
  estimateRequestCount(batch: ConnectorImportBatch): number;
}
