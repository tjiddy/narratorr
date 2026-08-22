import type { BookMetadata } from '@core/metadata/index.js';
import type { DuplicateReason, RecordingVerdict } from '@shared/schemas.js';
import type { MatchReasonKind } from '@shared/match-reason-kind.js';

export type Confidence = 'high' | 'medium' | 'none';

export interface MatchCandidate {
  path: string;
  title: string;
  author?: string | undefined;
  /** Folder-derived wanted position; zero is valid. */
  seriesPosition?: number | undefined;
}

export interface MatchResult {
  path: string;
  confidence: Confidence;
  bestMatch: BookMetadata | null;
  alternatives: BookMetadata[];
  error?: string;
  reason?: string;
  /** Duration-review discriminator; client logic must never parse `reason` text. */
  reasonKind?: MatchReasonKind;
  /** Positive, unrounded scanner runtime in seconds, independent of confidence. */
  scannedSeconds?: number;
  /** Duplicate state from the resolved match, propagated to import review. */
  isDuplicate?: boolean;
  existingBookId?: number; duplicateReason?: DuplicateReason;
  /** #2091: the flagged incumbent's own folder; set only alongside a `slug` duplicate. */
  existingPath?: string;
  /** Display-only recording warning, not a hard duplicate. */
  reviewReason?: string;
  /** Library-hit recording verdict; absent for a genuinely new book. */
  recordingVerdict?: RecordingVerdict;
}

export interface MatchJobStatus {
  id: string;
  status: 'matching' | 'completed' | 'failed' | 'cancelled';
  total: number;
  matched: number;
  results: MatchResult[];
  /** Terminal run failure retained alongside partial results until TTL. */
  error?: string;
}
