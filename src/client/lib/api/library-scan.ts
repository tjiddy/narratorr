import { fetchApi } from './client.js';
import type { BookMetadata } from './books.js';

export type { DiscoveredBook, DuplicateReason, ImportMode, HeldReviewItem } from '../../../shared/schemas/library-scan.js';
import type { DiscoveredBook, DuplicateReason, ImportMode, HeldReviewItem } from '../../../shared/schemas/library-scan.js';
import type { RecordingVerdict } from '../../../shared/schemas/recording-verdict.js';

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

export interface ImportResult {
  accepted: number;
  /** Items held back for recording review (#1711) — not enqueued; re-confirm with forceImport. */
  heldReview: HeldReviewItem[];
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
}

export interface MatchResult {
  path: string;
  confidence: Confidence;
  bestMatch: BookMetadata | null;
  alternatives: BookMetadata[];
  error?: string;
  reason?: string;
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
  status: 'matching' | 'completed' | 'cancelled';
  total: number;
  matched: number;
  results: MatchResult[];
}

export const libraryScanApi = {
  rescanLibrary: () =>
    fetchApi<RescanResult>('/library/rescan', { method: 'POST' }),
  scanDirectory: (path: string) =>
    fetchApi<ScanResult>('/library/import/scan', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  confirmImport: (books: ImportConfirmItem[], mode?: ImportMode) =>
    fetchApi<ImportResult>('/library/import/confirm', {
      method: 'POST',
      body: JSON.stringify({ books, mode }),
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
