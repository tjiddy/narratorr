import { isCapExceededError } from './counting-stream.js';

/**
 * Error classification for the companion-EPUB read path (#1986, design §4).
 *
 * **The predicate fails toward propagation, not toward a verdict.** An earlier
 * revision allowlisted the filesystem errnos that propagate and mapped
 * everything else to `truncated`; Node's system-error list is explicitly
 * non-exhaustive, so `ETIMEDOUT` from a network mount or `ENODEV` from a
 * removable device would have been persisted as a durable corruption verdict.
 * This is inverted: an error is a decoder failure only when *provably* so.
 * `cap-exceeded` narrows the decoder-failure arm further — it is the one
 * failure this codebase raises itself and can therefore identify exactly.
 *
 * Deliberately **not** `isDefinitiveAbsence` (`src/server/utils/fs-errno.ts`):
 * that helper answers "does this prove the path is gone?", this one answers "is
 * this provably the archive decoder?" — different questions with different
 * answers for `ENOENT`. It could not be imported across the layer guard anyway,
 * so the `code` shape read is reimplemented locally.
 */

/** What a caught value is, never what to do about it. */
export type EpubReadErrorLabel = 'cap-exceeded' | 'decoder-failure' | 'throw';

/** How the caller obtained the value. Required, so the decision is never made by omission. */
export interface EpubErrorProvenance {
  /** True only when the value was caught around an archive read (open, entry stream, inflate). */
  readonly archiveRead: boolean;
}

/** Decoder codes: zlib's own `Z_*` set plus Node's `ERR_ZLIB_*` wrappers. */
const DECODER_CODE_RE = /^(?:Z_|ERR_ZLIB_)/;

/** The excluded subclasses — a defect in our own code, or a hostile value that reached the library. */
const EXCLUDED_SUBCLASSES = [TypeError, RangeError, ReferenceError] as const;

/**
 * Read a `code` off an error, treating nullish as absent.
 *
 * `{ code: undefined }` and `{ code: null }` are exactly an error with no `code`
 * property — the distinction has no mechanical meaning. A **non-nullish**
 * non-string `code` (a numeric errno-style value, a symbol) is *not* absent: it
 * is returned as `false` so the caller can propagate. Same shape guard as
 * `errnoCode`, reimplemented rather than imported.
 */
function readCode(error: Error): string | false | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  if (code === undefined || code === null) return undefined;
  return typeof code === 'string' ? code : false;
}

/**
 * Classify any caught value. Total over `unknown` — `useUnknownInCatchVariables`
 * is on and a promise or stream may reject with any JavaScript value, so every
 * value lands in a defined arm.
 *
 * Classification only: what each label *means* is the call site's decision.
 * Informatively, and binding on no one from here — a mandatory read maps
 * `cap-exceeded` → `limit_exceeded` and `decoder-failure` → `truncated`, an
 * optional read maps both to a `null` field, and `throw` propagates everywhere.
 */
export function classifyEpubReadError(
  value: unknown,
  provenance: EpubErrorProvenance,
): EpubReadErrorLabel {
  // 1. Our own cap breach, first and unconditionally — the identity is one this
  //    codebase constructs, so no provenance question arises. Evaluating it here
  //    is what removes the caller-ordering problem: "classify every error" is
  //    correct as written at every consumer.
  if (isCapExceededError(value)) return 'cap-exceeded';

  // 2. Anything that is not an Error is an indeterminate programming or library
  //    failure, never evidence of a corrupt book.
  if (!(value instanceof Error)) return 'throw';

  // 3. Without stated archive-read provenance we cannot attribute anything.
  //    Read defensively: a missing decision propagates, same as a negative one.
  if (provenance?.archiveRead !== true) return 'throw';

  // 4. These never mean a corrupt book, whatever code they carry.
  if (EXCLUDED_SUBCLASSES.some((ctor) => value instanceof ctor)) return 'throw';

  // 5. A present code that is not a decoder code propagates. This is an
  //    allowlist of decoder shapes, not a denylist of errnos — it covers
  //    `EACCES` and `EIO` and equally the codes Node does not document, plus
  //    ordinary non-errno strings such as `ERR_STREAM_PREMATURE_CLOSE`.
  const code = readCode(value);
  if (code !== undefined && (code === false || !DECODER_CODE_RE.test(code))) return 'throw';

  // 6. A zlib-coded or uncoded Error from an archive read is the deliberately
  //    accepted decoder-failure case.
  return 'decoder-failure';
}
