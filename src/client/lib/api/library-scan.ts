import { fetchApi } from './client.js';
import type { BookMetadata } from './books.js';

export type { DiscoveredBook, DuplicateReason, ImportMode, HeldReviewItem, DurationCorroborationResult } from '@shared/schemas/library-scan.js';
import type { DurationCorroborationBody, DurationCorroborationResult } from '@shared/schemas/library-scan.js';
import type { DiscoveredBook, DuplicateReason } from '@shared/schemas/library-scan.js';
import type { RecordingVerdict } from '@shared/schemas/recording-verdict.js';
import type { MatchReasonKind } from '@shared/match-reason-kind.js';

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
  /** Bypasses the server's title-and-author duplicate safety check. */
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
  /** Folder-derived position used to break same-title series ties. */
  seriesPosition?: number;
}

export interface MatchResult {
  path: string;
  confidence: Confidence;
  bestMatch: BookMetadata | null;
  alternatives: BookMetadata[];
  error?: string;
  reason?: string;
  /** Structured duration-review reason; never derive it by parsing the display text. */
  reasonKind?: MatchReasonKind;
  /** Raw positive scanner runtime in seconds, preserved unrounded for re-pick checks. */
  scannedSeconds?: number;
  /** Post-match hard duplicate; merging propagates it and deselects the row. */
  isDuplicate?: boolean;
  existingBookId?: number;
  duplicateReason?: DuplicateReason;
  /** #2091: the flagged incumbent's own folder; merged onto the row for the review-list section. */
  existingPath?: string;
  /** Display-only recording warning that does not hard-skip the row. */
  reviewReason?: string;
  /** Library-hit recording verdict driving ImportCard's ownership badge. */
  recordingVerdict?: RecordingVerdict;
}

export interface MatchJobStatus {
  id: string;
  status: 'matching' | 'completed' | 'failed' | 'cancelled';
  total: number;
  matched: number;
  results: MatchResult[];
  /** Failed jobs only; recovery UI maps this instead of rendering it raw. */
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
  /** Dumb transport: callers normalize ASIN; scanner seconds remain raw and unrounded. */
  corroborateImportDuration: (body: DurationCorroborationBody) =>
    fetchApi<DurationCorroborationResult>('/library/import/duration-corroboration', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
