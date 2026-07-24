import { fetchApi } from './client.js';
import type { BookMetadata } from './books.js';

export type { DiscoveredBook, DuplicateReason, ImportMode, HeldReviewItem } from '../../../shared/schemas/library-scan.js';
import type { DiscoveredBook, DuplicateReason } from '../../../shared/schemas/library-scan.js';
import type { RecordingVerdict } from '../../../shared/schemas/recording-verdict.js';
import type { MatchReasonKind } from '../../../shared/match-reason-kind.js';

export interface ImportConfirmItem {
  path: string;
  title: string;
  authorName?: string;
  seriesName?: string;
  narrators?: string[];
  seriesPosition?: number;
  coverUrl?: string;
  asin?: string;
  metadata?: BookMetadata;
  /** When true, bypasses the server-side title+author safety-net duplicate check */
  forceImport?: boolean;
}

export interface ScanResult {
  discoveries: DiscoveredBook[];
  totalFolders: number;
}

export interface RescanResult {
  scanned: number;
  missing: number;
  restored: number;
}

export type Confidence = 'high' | 'medium' | 'none';

export interface MatchCandidate {
  path: string;
  title: string;
  author?: string;
  /** Wanted series position parsed from the folder name (#1849), sent to the
   * match-start endpoint so the ranker can break same-title series ties. */
  seriesPosition?: number;
}

export interface MatchResult {
  path: string;
  confidence: Confidence;
  bestMatch: BookMetadata | null;
  alternatives: BookMetadata[];
  error?: string;
  reason?: string;
  /**
   * Structured discriminator for the duration-confidence Review reason (#1929).
   * Mirrors the server `MatchResult`. Paired with `reason` (never parsed from it);
   * `upgradeMatchConfidence` branches on it to decide whether an explicit re-pick
   * re-evaluates the duration evidence (`duration-mismatch`/`missing-duration`) or
   * clears to high as today (`no-duration-data` / `undefined` legacy).
   */
  reasonKind?: MatchReasonKind;
  /**
   * Raw unrounded scanner runtime in SECONDS (#1929). Mirrors the server
   * `MatchResult`. Threaded onto every result the scanner gave a positive runtime,
   * so `upgradeMatchConfidence` can re-check a picked edition's `duration * 60`
   * against it on a medium re-pick. Absent when the scan found no positive runtime.
   */
  scannedSeconds?: number;
  /**
   * Post-match library-duplicate flags (#1662). Mirrors the server `MatchResult`.
   * `mergeMatchIntoRow` propagates these onto `row.book` so the existing
   * "Already in library" badge lights up and the row fails closed (deselected).
   */
  isDuplicate?: boolean;
  existingBookId?: number;
  duplicateReason?: DuplicateReason;
  /**
   * Display-only recording-review warning (#1711). Mirrors the server `MatchResult`.
   * `mergeMatchIntoRow` propagates this onto `row.book.reviewReason` so the import
   * UI surfaces "possible different recording" without hard-skipping the row.
   */
  reviewReason?: string;
  /**
   * Recording-identity verdict for a library hit (#1712). Mirrors the server
   * `MatchResult`. `mergeMatchIntoRow` propagates it onto `row.book.recordingVerdict`
   * so `ImportCard` renders the three-way duplicate badge.
   */
  recordingVerdict?: RecordingVerdict;
}

export interface MatchJobStatus {
  id: string;
  status: 'matching' | 'completed' | 'failed' | 'cancelled';
  total: number;
  matched: number;
  results: MatchResult[];
  /** Present only on a terminal `'failed'` job (#1864). Mirrors the server
   * `MatchJobStatus`. Never rendered raw — the recovery banner maps by reason. */
  error?: string;
}

export const libraryScanApi = {
  rescanLibrary: () =>
    fetchApi<RescanResult>('/library/rescan', { method: 'POST' }),
  scanDirectory: (path: string) =>
    fetchApi<ScanResult>('/library/import/scan', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  startMatchJob: (books: MatchCandidate[]) =>
    fetchApi<{ jobId: string }>('/library/import/match', {
      method: 'POST',
      body: JSON.stringify({ books }),
    }),
  getMatchJob: (jobId: string) =>
    fetchApi<MatchJobStatus>(`/library/import/match/${jobId}`),
  cancelMatchJob: (jobId: string) =>
    fetchApi<{ cancelled: boolean }>(`/library/import/match/${jobId}`, {
      method: 'DELETE',
    }),
};
