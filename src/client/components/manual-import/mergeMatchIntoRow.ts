import type { MatchResult } from '@/lib/api';
import { buildEditedFromBestMatch } from './buildEditedFromBestMatch.js';
import type { ImportRow } from './types.js';

/**
 * Merges a freshly-arrived match result into an import row: applies the
 * selection-safety predicate and auto-populates edited fields from the best
 * match. Shared by both Manual Import and Library Import so the predicate cannot
 * drift between the twin hooks (#1374) — the recurring drift class that #1318's
 * byte-identical-twins review flagged.
 *
 * The caller owns the duplicate-skip decision (library uses `isDbDuplicate`,
 * manual uses `row.book.isDuplicate`) and must short-circuit before delegating;
 * this helper only owns the selection predicate + auto-populate.
 *
 * Selection rules:
 * - A row the user explicitly FIXED via the edit modal (`userEdited`) keeps its
 *   current selection regardless of the incoming confidence — discrete user
 *   intent is not the merge predicate's to override (#1374).
 * - Otherwise only `'high'` confidence preserves the prior selection; medium /
 *   none / unknown fail closed to unchecked so importing an unreviewed match is
 *   never the default (#1318).
 */
export function mergeMatchIntoRow(row: ImportRow, match: MatchResult): ImportRow {
  const selected = row.userEdited
    ? row.selected
    : (match.confidence === 'high' ? row.selected : false);

  // Auto-populate edited fields from the best match only when the user hasn't
  // already edited this row. A row counts as edited if the user committed a fix
  // through the modal (`userEdited`) — true even when they corrected fields
  // manually WITHOUT picking a provider result, in which case `edited.metadata`
  // is undefined (#1374 F1) — OR a prior merge already populated it
  // (`edited.metadata` set). Keying on `edited.metadata` alone would let a later
  // bestMatch overwrite a no-metadata manual correction.
  const wasEdited = row.userEdited || row.edited.metadata !== undefined;
  if (!wasEdited && match.bestMatch) {
    return {
      ...row,
      matchResult: match,
      selected,
      edited: buildEditedFromBestMatch(match.bestMatch, row.edited),
    };
  }
  return { ...row, matchResult: match, selected };
}
