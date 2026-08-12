import { describe, it, expect } from 'vitest';
import type {
  EpubValidationCode,
  EpubValidation,
  EpubInspection,
  EpubMetadata,
  EpubTocEntry,
  EpubCover,
} from './result.js';

// Union contracts are pinned by typecheck; runtime assertions keep this a valid suite.

const FULL_METADATA: EpubMetadata = { title: 'Dune', author: 'Frank Herbert', language: 'en' };

describe('EpubValidationCode — exhaustiveness pin', () => {
  it('has exactly eleven members', () => {
    const ALL_CODES: Record<EpubValidationCode, true> = {
      not_a_zip: true,
      truncated: true,
      bad_mimetype: true,
      missing_container: true,
      unresolvable_package: true,
      empty_manifest: true,
      empty_spine: true,
      unsafe_entry_path: true,
      duplicate_entry: true,
      malformed_xml: true,
      limit_exceeded: true,
    };

    expect(Object.keys(ALL_CODES)).toHaveLength(11);
  });
});

describe('EpubValidation — discrimination pin', () => {
  it('exposes `code` only on the invalid arm', () => {
    const invalid: EpubValidation = { status: 'invalid', code: 'bad_mimetype' };
    expect(invalid.status === 'invalid' && invalid.code).toBe('bad_mimetype');

    const drm: EpubValidation = { status: 'drm_protected' };
    // @ts-expect-error - `code` belongs to the `invalid` arm only
    const drmCode = drm.code;
    expect(drmCode).toBeUndefined();

    const available: EpubValidation = { status: 'available' };
    // @ts-expect-error - `code` belongs to the `invalid` arm only
    const availableCode = available.code;
    expect(availableCode).toBeUndefined();
  });

  it('rejects a status outside the three arms', () => {
    // @ts-expect-error - `ambiguous` is a discovery status, never a validation status
    const bogus: EpubValidation = { status: 'ambiguous' };
    expect(bogus.status).toBe('ambiguous');
  });

  it('requires `code` on the invalid arm', () => {
    // @ts-expect-error - an invalid validation must carry its reason code
    const noCode: EpubValidation = { status: 'invalid' };
    expect(noCode.status).toBe('invalid');
  });
});

describe('EpubInspection — discrimination pin', () => {
  it('keeps the drm_protected and invalid arms', () => {
    const drm: EpubInspection = { status: 'drm_protected' };
    const invalid: EpubInspection = { status: 'invalid', code: 'malformed_xml' };

    expect([drm.status, invalid.status]).toEqual(['drm_protected', 'invalid']);
    expect(invalid.status === 'invalid' && invalid.code).toBe('malformed_xml');
  });

  it('exposes `code` only on the invalid arm', () => {
    const drm: EpubInspection = { status: 'drm_protected' };
    // @ts-expect-error - `code` belongs to the `invalid` arm only
    const drmCode = drm.code;
    expect(drmCode).toBeUndefined();

    const available: EpubInspection = {
      status: 'available',
      metadata: FULL_METADATA,
      toc: null,
      cover: null,
    };
    // @ts-expect-error - `code` belongs to the `invalid` arm only
    const availableCode = available.code;
    expect(availableCode).toBeUndefined();
  });

  it('keeps the available payload off the other arms', () => {
    const invalid: EpubInspection = { status: 'invalid', code: 'truncated' };
    // @ts-expect-error - `metadata` belongs to the `available` arm only
    const invalidMetadata = invalid.metadata;
    expect(invalidMetadata).toBeUndefined();
  });

  it('rejects a status outside the three arms', () => {
    // @ts-expect-error - `ambiguous` is a discovery status, never an inspection status
    const bogus: EpubInspection = { status: 'ambiguous' };
    expect(bogus.status).toBe('ambiguous');
  });

  it('requires `code` on the invalid arm', () => {
    // @ts-expect-error - an invalid inspection must carry its reason code
    const noCode: EpubInspection = { status: 'invalid' };
    expect(noCode.status).toBe('invalid');
  });
});

describe('EpubInspection — payload pin', () => {
  it('accepts a complete available inspection in every nullable spelling', () => {
    const withEverything: EpubInspection = {
      status: 'available',
      metadata: FULL_METADATA,
      toc: [{ title: 'Chapter One', depth: 0 }],
      cover: { mediaType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8]) },
    };
    const withNulls: EpubInspection = {
      status: 'available',
      metadata: { title: null, author: null, language: null },
      toc: null,
      cover: null,
    };

    expect(withEverything.status === 'available' && withEverything.toc).toHaveLength(1);
    expect(withNulls.status === 'available' && withNulls.cover).toBeNull();
  });

  it('requires every nested field on the available arm', () => {
    // @ts-expect-error - `metadata` is required on an available inspection
    const noMetadata: EpubInspection = { status: 'available', toc: null, cover: null };
    // @ts-expect-error - `toc` is required (nullable, not optional)
    const noToc: EpubInspection = { status: 'available', metadata: FULL_METADATA, cover: null };
    // @ts-expect-error - `cover` is required (nullable, not optional)
    const noCover: EpubInspection = { status: 'available', metadata: FULL_METADATA, toc: null };

    expect([noMetadata.status, noToc.status, noCover.status]).toEqual([
      'available',
      'available',
      'available',
    ]);
  });

  it('requires every EpubMetadata field', () => {
    // @ts-expect-error - `title` is required (nullable, not optional)
    const noTitle: EpubMetadata = { author: null, language: null };
    // @ts-expect-error - `author` is required (nullable, not optional)
    const noAuthor: EpubMetadata = { title: null, language: null };
    // @ts-expect-error - `language` is required (nullable, not optional)
    const noLanguage: EpubMetadata = { title: null, author: null };

    expect([noTitle.language, noAuthor.language, noLanguage.title]).toEqual([null, null, null]);
  });

  it('requires both EpubTocEntry fields', () => {
    // @ts-expect-error - `depth` is required
    const noDepth: EpubTocEntry = { title: 'Chapter One' };
    // @ts-expect-error - `title` is required
    const noTitle: EpubTocEntry = { depth: 0 };

    expect([noDepth.title, noTitle.depth]).toEqual(['Chapter One', 0]);
  });

  it('constrains the cover media type and byte payload', () => {
    // @ts-expect-error - SVG is outside the four permitted cover media types
    const svgCover: EpubCover = { mediaType: 'image/svg+xml', bytes: Buffer.alloc(0) };
    // @ts-expect-error - `bytes` is a Buffer, never a string
    const stringBytes: EpubCover = { mediaType: 'image/png', bytes: 'not-a-buffer' };

    expect([svgCover.mediaType, stringBytes.bytes]).toEqual(['image/svg+xml', 'not-a-buffer']);
  });

  it('requires both EpubCover fields', () => {
    // @ts-expect-error - `mediaType` is required
    const noMediaType: EpubCover = { bytes: Buffer.alloc(0) };
    // @ts-expect-error - `bytes` is required
    const noBytes: EpubCover = { mediaType: 'image/png' };

    expect([noMediaType.bytes, noBytes.mediaType]).toEqual([Buffer.alloc(0), 'image/png']);
  });
});
