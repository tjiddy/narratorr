import type { BookMetadata } from '../../core/metadata/index.js';
import type { DuplicateReason, RecordingVerdict } from '../../shared/schemas.js';

/**
 * Match-job data contracts. Extracted from `match-job.service.ts` (#1864 file-size
 * cap) — types only, so `match-job.helpers.ts` and the service both import from here
 * without the prior service↔helpers type cycle.
 */

export type Confidence = 'high' | 'medium' | 'none';

export interface MatchCandidate {
  path: string;
  title: string;
  author?: string | undefined;
  /** Wanted series position parsed from the folder name (#1849), threaded
   * from the scan API body through to the shared position tiebreaker in
   * `rankResults`. Position 0 is valid (#1028); preserved via `!== undefined`. */
  seriesPosition?: number | undefined;
}

export interface MatchResult {
  path: string;
  confidence: Confidence;
  bestMatch: BookMetadata | null;
  alternatives: BookMetadata[];
  error?: string;
  reason?: string;
  /** Post-match library-duplicate flags (#1662), set from the resolved `bestMatch`
   * (which carries the author/asin a no-author filename lacks). The client merge
   * propagates these onto `row.book` so the badge lights up and the row fails closed. */
  isDuplicate?: boolean;
  existingBookId?: number; duplicateReason?: DuplicateReason;
  /** Display-only recording-review warning (#1711): the matched recording may be a
   * DIFFERENT recording of a book you own but narrators could not be compared. Not
   * a hard duplicate — the row still flows; the client surfaces it on `row.book`. */
  reviewReason?: string;
  /** Recording-identity verdict for a library hit (#1712), set by `applyLibraryDuplicate`.
   * Drives the three-way import-review badge; absent for a genuinely new book. Mirrored on
   * the shared `discoveredBookSchema` + client `MatchResult`. */
  recordingVerdict?: RecordingVerdict;
}

export interface MatchJobStatus {
  id: string;
  status: 'matching' | 'completed' | 'failed' | 'cancelled';
  total: number;
  matched: number;
  results: MatchResult[];
  /** Populated only on a terminal `'failed'` (a top-level `run()` crash, #1864).
   * Retained alongside partial results until TTL so the client can classify the
   * failure without exposing raw text in the UI (the paused banner maps by reason). */
  error?: string;
}
