import { isCapExceededError } from './counting-stream.js';

/**
 * Classifies only provable archive-decoder failures; everything indeterminate propagates.
 * Node's errno set is non-exhaustive, so decoder shapes are allowed rather than errnos denied.
 */

/** Describes what a caught value is, never what callers should do about it. */
export type EpubReadErrorLabel = 'cap-exceeded' | 'decoder-failure' | 'throw';

/** Required so archive provenance is never inferred by omission. */
export interface EpubErrorProvenance {
  readonly archiveRead: boolean;
}

/** Decoder codes: zlib's own `Z_*` set plus Node's `ERR_ZLIB_*` wrappers. */
const DECODER_CODE_RE = /^(?:Z_|ERR_ZLIB_)/;

/** The excluded subclasses — a defect in our own code, or a hostile value that reached the library. */
const EXCLUDED_SUBCLASSES = [TypeError, RangeError, ReferenceError] as const;

/** Nullish codes are absent; a present non-string code returns false so it propagates. */
function readCode(error: Error): string | false | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  if (code === undefined || code === null) return undefined;
  return typeof code === 'string' ? code : false;
}

/** Total classification over unknown; policy remains at each call site. */
export function classifyEpubReadError(
  value: unknown,
  provenance: EpubErrorProvenance,
): EpubReadErrorLabel {
  // Module-created cap identity takes precedence over provenance.
  if (isCapExceededError(value)) return 'cap-exceeded';

  // Non-Errors are indeterminate, never evidence of archive corruption.
  if (!(value instanceof Error)) return 'throw';

  // Without explicit archive-read provenance, attribution is unsafe.
  if (provenance?.archiveRead !== true) return 'throw';

  // Programmer-error subclasses never imply a corrupt archive.
  if (EXCLUDED_SUBCLASSES.some((ctor) => value instanceof ctor)) return 'throw';

  // Allow decoder-shaped codes; every other present code propagates.
  const code = readCode(value);
  if (code !== undefined && (code === false || !DECODER_CODE_RE.test(code))) return 'throw';

  return 'decoder-failure';
}
