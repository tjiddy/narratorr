import type { EpubValidationCode } from '@core/epub/result.js';
import { ApiError } from '@/lib/api';
import type { BadgeVariant } from '@/components/Badge';
import type { CompanionEbookStatus } from '@shared/schemas/companion-ebook.js';

// ============================================================================
// Every string the Ebook panel owns, in ONE module (#1963).
//
// The panel's bodies are split across small components; the copy is deliberately
// not. Two files each holding a subset of these strings is how the verbatim-copy
// requirement decays. Two style rules govern every string here and any string
// added later:
//
//   * No em-dashes. Use a period, a comma, or a colon.
//   * No verbs that frame Narratorr as watching the filesystem. It SHOWS or USES
//     files the owner placed; it does not NOTICE them.
//
// And one naming invariant: the product term "companion" appears nowhere the
// owner can read it. The panel is headed "Ebook"; the format is named only when
// something is wrong. `CompanionEbookSection.test.tsx` enforces all three
// mechanically over rendered text, `aria-label`, `title`, and the toast copy.
// ============================================================================

/** The section heading. Never "Companion EPUB". */
export const SECTION_HEADING = 'Ebook';

/** The pill text for the four states whose pill is a constant. `ambiguous` is `${N} found`. */
export const PILLS = {
  available: 'Available',
  none: 'None',
  invalid: 'Not readable',
  drm_protected: 'DRM-protected',
} as const;

/** `ambiguous`'s pill. N is `candidates.length` — the array the radios render, never `candidateCount`. */
export function ambiguousPill(candidateCount: number): string {
  return `${candidateCount} found`;
}

export const BADGE_VARIANTS: Record<CompanionEbookStatus, BadgeVariant> = {
  available: 'success',
  none: 'muted',
  ambiguous: 'warning',
  invalid: 'danger',
  drm_protected: 'warning',
};

export const DOWNLOAD_LABEL = 'Download EPUB';

/**
 * The `available` detail row's chapter term (#2022), pluralized on 1.
 *
 * N is `toc.length` and nothing else. It is never reached with `0`: `src/core/epub/extract.ts`
 * yields `null` rather than an empty array when a traversal emits no rows, and the panel renders
 * no count at all for `toc: null` — so "0 chapters" is unreachable by construction and no
 * fallback copy is authored for it.
 */
export function chapterCountText(count: number): string {
  return `${count} chapter${count === 1 ? '' : 's'}`;
}

/** The separator joining the `available` detail row's present parts. Never an em-dash. */
export const DETAIL_SEPARATOR = ' · ';

/** The header refresh affordance (#2034). "Re-check", never "rescan": Refresh & Scan is the
 *  whole-book action and re-probes the audio; this one re-judges only the ebook. */
export const REFRESH_LABEL = 'Re-check ebook';

/** Toast when the refresh POST itself fails. The reconcile's own failures are server-side
 *  and surface as an unchanged panel, which the sentence covers with "try again". */
export const REFRESH_ERROR_TOAST = "Couldn't re-check the ebook. Try again in a moment.";

// --- `none` ----------------------------------------------------------------
// Split into three parts only so `.epub` can render inside a <code>; the whole
// sentence is `NONE_BODY`, and the element's accessible text must equal it.
export const NONE_BODY_PREFIX = 'Drop a single ';
export const NONE_BODY_CODE = '.epub';
export const NONE_BODY_SUFFIX = " into this book's folder, shown under Location below, then rescan.";
export const NONE_BODY = `${NONE_BODY_PREFIX}${NONE_BODY_CODE}${NONE_BODY_SUFFIX}`;

// --- `ambiguous` -----------------------------------------------------------
export const AMBIGUOUS_QUESTION = 'Which one belongs to this book?';
export const AMBIGUOUS_SUBMIT = 'Use this one';
export const SELECTION_SUCCESS_TOAST = 'Ebook selection saved';

// --- `drm_protected` -------------------------------------------------------

/**
 * "downloaded or" was dropped in #2038, when the exposure split landed. Only the Kindle half of
 * the original sentence was ever reasoned — a DRM'd EPUB genuinely fails Amazon's converter —
 * while the download half fell out of one shared gate that answered both questions at once. The
 * owner downloads their own file now, so the sentence may not claim otherwise.
 */
export const DRM_BODY =
  "Its chapters are encrypted. Narratorr won't remove DRM, so this can't be sent to Kindle.";

// --- `invalid` -------------------------------------------------------------

/**
 * A constant frame plus a per-code reason clause. The plan authors exactly one `invalid`
 * sentence; `validation_code` carries ELEVEN codes, and the DB guarantees it is non-null for
 * exactly `status = 'invalid'`. `Record<EpubValidationCode, string>` means a twelfth code
 * fails typecheck rather than falling through to a generic sentence.
 *
 * These clauses are exact copy. Swapping two of them gives the owner a false diagnosis, so
 * `CompanionEbookSection.test.tsx` asserts all eleven complete sentences verbatim.
 * `empty_spine` is the anchor: its full sentence reproduces the plan's authored string.
 *
 * Plain-language register throughout: no internal filenames, no `spine`/`manifest` jargon.
 */
export const INVALID_REASONS: Record<EpubValidationCode, string> = {
  not_a_zip: "it isn't a readable archive",
  truncated: 'the file is incomplete',
  bad_mimetype: "it isn't marked as an EPUB",
  missing_container: 'it has no index',
  unresolvable_package: "its index points to a file that isn't there",
  empty_manifest: 'it lists no files',
  empty_spine: 'it has no reading order',
  unsafe_entry_path: 'it contains an unsafe file path',
  duplicate_entry: 'it contains duplicate entries',
  malformed_xml: 'its internal structure is damaged',
  limit_exceeded: "it's larger or more complex than Narratorr will read",
};

/** The frame with the colon clause dropped — a null code, or one outside the eleven. */
export const INVALID_SENTENCE_FALLBACK =
  "This isn't a valid EPUB. If it's still copying, wait and rescan.";

/**
 * `/state` types `validationCode` as `string | null` and the DB column is unconstrained text.
 *
 * Membership is an OWN-property check. A plain object literal inherits `constructor`,
 * `toString`, `hasOwnProperty`, and `__proto__` from `Object.prototype`, so `code in
 * INVALID_REASONS` or a bare `INVALID_REASONS[code]` truthiness test would return an
 * inherited value for those names and render a function body as owner-facing copy.
 */
export function invalidSentence(code: string | null): string {
  if (code !== null && Object.hasOwn(INVALID_REASONS, code)) {
    return `This isn't a valid EPUB: ${INVALID_REASONS[code as EpubValidationCode]}. If it's still copying, wait and rescan.`;
  }
  return INVALID_SENTENCE_FALLBACK;
}

// --- selection failures ----------------------------------------------------

/**
 * Selection error copy is authored HERE and keyed on HTTP status. Ten of the eleven shipped
 * selection failures contain the word "Companion" (`src/server/routes/companion-ebook.ts`), so
 * `getErrorMessage(error)` would pipe banned vocabulary straight into a toast. The server
 * sentences stay as they are — they are API responses, pinned by #1974/#1976.
 *
 * Status is the whole key: never branch on the server's message text, which is not a contract.
 * Both `409` arms (`disabled` and `conflicted`) share one line deliberately — after either, a
 * refresh is the correct next action, and for `disabled` the refresh also makes the section
 * disappear, which explains itself.
 */
export const SELECTION_ERROR_FALLBACK = "Your choice couldn't be saved. Try again in a moment.";

const SELECTION_ERRORS: Record<number, string> = {
  400: 'That file is no longer in the list. Pick again.',
  404: "That ebook isn't there anymore. Rescan and try again.",
  409: 'Something changed while you were choosing. Refresh the page and try again.',
  503: SELECTION_ERROR_FALLBACK,
};

/** An unmapped `ApiError` status and a non-`ApiError` rejection both get the generic sentence. */
export function selectionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && Object.hasOwn(SELECTION_ERRORS, error.status)) {
    return SELECTION_ERRORS[error.status]!;
  }
  return SELECTION_ERROR_FALLBACK;
}
