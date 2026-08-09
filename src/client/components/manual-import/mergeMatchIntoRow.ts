import type { MatchResult } from '@/lib/api';
import { buildEditedFromBestMatch } from './buildEditedFromBestMatch.js';
import type { ImportRow } from './types.js';

/**
 * Shared match merge for both import flows; callers must skip their own DB
 * duplicates first. Post-match duplicates deselect, user-edited rows preserve
 * selection, and otherwise only high confidence preserves it. Best-match fields
 * populate only untouched rows.
 */
export function mergeMatchIntoRow(row: ImportRow, match: MatchResult): ImportRow {
  const isPostMatchDuplicate = match.isDuplicate === true;

  const selected = isPostMatchDuplicate
    ? false
    : row.userEdited
      ? row.selected
      : (match.confidence === 'high' ? row.selected : false);

  // Propagate hard duplicates for downstream skip/badge checks; review-only rows still flow.
  const baseBook = isPostMatchDuplicate
    ? {
        ...row.book,
        isDuplicate: true,
        ...(match.existingBookId !== undefined && { existingBookId: match.existingBookId }),
        ...(match.duplicateReason !== undefined && { duplicateReason: match.duplicateReason }),
      }
    : match.reviewReason !== undefined
      ? { ...row.book, reviewReason: match.reviewReason }
      : row.book;
  // Recording verdict is orthogonal to duplicate/review flags and always propagates.
  const book = match.recordingVerdict !== undefined
    ? { ...baseBook, recordingVerdict: match.recordingVerdict }
    : baseBook;

  // userEdited includes manual fixes without metadata; metadata alone would miss and clobber them.
  const wasEdited = row.userEdited || row.edited.metadata !== undefined;
  if (!wasEdited && match.bestMatch) {
    return {
      ...row,
      book,
      matchResult: match,
      selected,
      edited: buildEditedFromBestMatch(match.bestMatch, row.edited),
    };
  }
  return { ...row, book, matchResult: match, selected };
}
