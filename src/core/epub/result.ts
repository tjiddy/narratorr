/**
 * The frozen result vocabulary for companion-EPUB validation and inspection
 * (#1986, design §4).
 *
 * Types only — no logic, no predicates, no constructor helpers. The module has
 * no runtime surface at all, so every consumer imports from it with
 * `import type` (`tsconfig.json` sets `isolatedModules` and
 * `verbatimModuleSyntax`; a value import would fail the build). The union is
 * pinned at compile time by `result.test.ts`.
 */

/**
 * The eleven validation codes, frozen. Each one is persisted in
 * `companion_ebooks.validation_code` and maps to one owner-facing sentence in
 * the panel, so minting a twelfth has slate-wide cost. In particular a
 * non-regular file reuses `not_a_zip` — it reads as "this path does not present
 * a readable ZIP archive", which is exactly true of a directory, FIFO, socket,
 * device, or symlink.
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

/** A cover image extracted from inside the archive. */
export interface EpubCover {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  bytes: Buffer;
}

/**
 * The structural-validation outcome (1.1d).
 *
 * `drm_protected` is a **status**, not a validation code: the owner message and
 * the Kindle outcome both differ from `invalid`, and it is never downgraded.
 */
export type EpubValidation =
  | { status: 'available' }
  | { status: 'drm_protected' }
  | { status: 'invalid'; code: EpubValidationCode };

/** The inspection outcome (1.1e) — validation plus the payload the owner panel renders. */
export type EpubInspection =
  | { status: 'available'; metadata: EpubMetadata; toc: EpubTocEntry[] | null; cover: EpubCover | null }
  | { status: 'drm_protected' }
  | { status: 'invalid'; code: EpubValidationCode };
