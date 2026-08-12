/**
 * Persisted validation vocabulary; adding a code requires an owner-facing message.
 * Non-regular files reuse `not_a_zip` rather than expanding this union.
 */
export type EpubValidationCode =
  | 'not_a_zip'
  | 'truncated'
  | 'bad_mimetype'
  | 'missing_container'
  | 'unresolvable_package'
  | 'empty_manifest'
  | 'empty_spine'
  | 'unsafe_entry_path'
  | 'duplicate_entry'
  | 'malformed_xml'
  | 'limit_exceeded';

/** Metadata lifted from the package document. Every field is present; a field we could not read is `null`. */
export interface EpubMetadata {
  title: string | null;
  author: string | null;
  language: string | null;
}

/** One flattened table-of-contents row. `depth` is the nesting level, zero-based. */
export interface EpubTocEntry {
  title: string;
  depth: number;
}

export interface EpubCover {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  bytes: Buffer;
}

/** DRM is a distinct status because its owner message and Kindle outcome differ from invalid. */
export type EpubValidation =
  | { status: 'available' }
  | { status: 'drm_protected' }
  | { status: 'invalid'; code: EpubValidationCode };

export type EpubInspection =
  | { status: 'available'; metadata: EpubMetadata; toc: EpubTocEntry[] | null; cover: EpubCover | null }
  | { status: 'drm_protected' }
  | { status: 'invalid'; code: EpubValidationCode };
