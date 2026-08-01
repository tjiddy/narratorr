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
 * Terms 1–2 of both gates, spelled ONCE (#2038 AC1). The two exported predicates differ in
 * exactly one thing — which stored observation statuses they admit — so that is the only thing
 * parameterised here. Not exported: a caller choosing its own status set is precisely the
 * per-call-site divergence the two named gates exist to prevent.
 */
function isCompanionEbookVisible(
  input: CompanionEbookExposureInput,
  permittedStatuses: readonly CompanionEbookStatus[],
): boolean {
  return (
    input.enabled &&
    input.bookStatus === 'imported' &&
    input.observationStatus != null &&
    permittedStatuses.includes(input.observationStatus)
  );
}

/**
 * The companion-ebook **advertisement** predicate (#1958, plan §1/§2 frozen contracts). Both
 * public producers (`toCompanionEbookV1` and the metadata-search `library` annotation) and the
 * public v1 stream call THIS function — the three terms never appear together anywhere else.
 *
 * **Advertisement only, and deliberately narrower than owner-readability since #2038.** The
 * owner's own file routes ask a different question at a different trust boundary and call
 * {@link isCompanionEbookOwnerReadable} instead. Nothing under `src/server/routes/v1/**` or
 * `src/shared/schemas/v1/**` may call the owner gate: a `drm_protected` EPUB genuinely fails
 * Amazon's Kindle converter, so advertising one to a consumer would promise a conversion that
 * cannot happen. `companion-ebook-exposure.test.ts` pins the two as a relation — the implication
 * plus the computed one-element difference set — so neither can drift into the other.
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
  return isCompanionEbookVisible(input, ['available']);
}

/**
 * The companion-ebook **owner-readability** predicate (#2038). The three owner file routes —
 * download, metadata, and cover — call THIS function, at the single shared call site in
 * `loadExposedCompanionContext`.
 *
 * It differs from {@link isCompanionEbookExposed} in one term and one term only: a stored
 * `drm_protected` row is owner-readable. The reasoning is not symmetric with advertisement, so
 * the two gates are not:
 *
 * - **Serving the bytes removes no DRM.** The file is already on the owner's disk, and a
 *   genuinely DRM'd book still opens only in the DRM-holder's own reader. Nothing about the
 *   owner download turns an encrypted EPUB into a readable one.
 * - **The classifier can be wrong, and was.** §4's `encryption.xml` and ZIP-bit rules read a
 *   legitimately obfuscated-font EPUB as DRM'd on the second real book they ever saw. Under one
 *   shared gate that misclassification denied the owner access to a perfectly good file; under
 *   this one the download works and the read routes recover on the live inspection.
 * - **Kindle is the asymmetry.** A DRM'd EPUB genuinely fails Amazon's converter, so the public
 *   surface that feeds send-to-Kindle keeps advertising `available` only.
 *
 * **It is still necessary, not sufficient**, in exactly the way the advertisement gate is: term 4
 * stays the caller's. For download that is `openCompanionEbook`'s live open; for metadata and
 * cover it is `inspectEpub`, which returns its own `drm_protected` arm for an encrypted spine or
 * content document and 404s there. Widening the STORED-status gate therefore cannot expose
 * encrypted content — a genuinely DRM'd file still fails the live term on both read routes.
 */
export function isCompanionEbookOwnerReadable(input: CompanionEbookExposureInput): boolean {
  return isCompanionEbookVisible(input, ['available', 'drm_protected']);
}
