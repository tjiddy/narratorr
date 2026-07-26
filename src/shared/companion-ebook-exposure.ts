import type { BookStatus } from './schemas/book.js';
import type { CompanionEbookStatus } from './schemas/companion-ebook.js';

export interface CompanionEbookExposureInput {
  /** `companionEpub.enabled` — the owner-facing feature flag. */
  enabled: boolean;
  /** `books.status` for the book the observation belongs to. */
  bookStatus: BookStatus;
  /** `companion_ebooks.status`, or null/undefined when the book has no observation row. */
  observationStatus: CompanionEbookStatus | null | undefined;
}

/**
 * The single shared companion-ebook exposure predicate (#1958, plan §1/§2 frozen
 * contracts). The owner metadata route, both public producers, and the stream all
 * call THIS function — the three terms never appear together anywhere else.
 *
 * **This helper decides advertisement, not readability.** It is terms 1–3 of the frozen
 * four-term predicate; term 4 — the live open (`lstat` regular-file + containment) — is
 * the *caller's* obligation and is the authority.
 *
 * - **It is necessary, not sufficient.** A `true` result means "advertise this," never
 *   "this will open." Only the stream (#1962) may answer the second question, and it
 *   answers it per request against the live file.
 * - **Known stale window.** A book on a transiently-unreachable mount (`EACCES`/`EIO`/
 *   `ESTALE`, or any code-less throw) retains `imported` by design since #1955, so this
 *   helper keeps returning `true` until a reconcile re-observes the book. The same holds
 *   after a library-root change: this function takes no path or root input, so rows
 *   validated under the old root keep advertising until re-observed. In both cases the
 *   owner-visible failure is a clean `404 companion_epub_unavailable` at click time —
 *   the accepted, bilaterally-agreed outcome (plan §8), not a defect.
 * - **Do not add a live term to this function.** It would force an `fs` dependency into
 *   `src/shared/**` (forbidden by the client import path and by `eslint.config.js`'s
 *   shared-layer boundary), and it would make the batch producers of #1961 `stat` once
 *   per search result on a public endpoint — the exact serve-time filesystem work
 *   Decision D removed.
 *
 * `books.status === 'imported'` is load-bearing: `library-scan.service.ts` flips
 * `imported → missing` without clearing `books.path` and without touching the companion
 * row, so dropping that term would keep a deleted book advertising an ebook forever.
 *
 * An absent observation (`null`/`undefined`) is `false`, never a throw.
 */
export function isCompanionEbookExposed(input: CompanionEbookExposureInput): boolean {
  return input.enabled && input.bookStatus === 'imported' && input.observationStatus === 'available';
}
