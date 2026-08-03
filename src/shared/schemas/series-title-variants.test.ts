import { describe, it, expect } from 'vitest';
import {
  variantTagSchema,
  variantSchema,
  titleVariantsDebugBodySchema,
  titleVariantsDebugResponseSchema,
  type Variant,
  type VariantTag,
} from './series-title-variants.js';
// Test files are exempt from the `src/shared` → `src/core` import boundary
// (eslint.config.js ignores `**/*.test.ts`), so these drift guards can reach
// into core to pin the core ↔ shared relationship at the type level. Mirrors
// `recording-verdict.test.ts:6-27`.
import type {
  Variant as CoreVariant,
  VariantTag as CoreVariantTag,
} from '@core/utils/title-variants.js';

/** Compile-time mutual-assignability check — true only when A and B are the same type. */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('variantTagSchema (#2096)', () => {
  it.each([['full'], ['first+last'], ['prefix(2)'], ['suffix(11)'], ['prefix(0)']])(
    'accepts %j',
    (tag) => {
      expect(variantTagSchema.safeParse(tag).success).toBe(true);
    },
  );

  it.each([['prefix()'], ['prefix(x)'], ['middle(1)'], ['prefix( 2 )'], ['Full'], ['prefix(2) ']])(
    'rejects %j',
    (tag) => {
      expect(variantTagSchema.safeParse(tag).success).toBe(false);
    },
  );

  // AC14 tag-numeric-domain note — DELIBERATE looseness, not an oversight.
  // `VariantTag` is declared as `` `prefix(${number})` ``, and `${number}` admits
  // fractions and negatives. Tightening the schema to `\d+` would make it stop
  // being exactly the declared type, which is the divergence AC14 exists to
  // prevent. That `n` is always a positive integer is a GENERATOR invariant,
  // observed in `src/core/utils/title-variants.test.ts`, not here.
  it.each([['prefix(1.5)'], ['prefix(-2)']])('accepts %j — the declared `${number}` domain', (tag) => {
    expect(variantTagSchema.safeParse(tag).success).toBe(true);
  });
});

describe('variantSchema (#2096)', () => {
  it('parses a well-formed variant', () => {
    const parsed = variantSchema.safeParse({ raw: 'star wars', tag: 'prefix(1)', parensStripped: true });
    expect(parsed.success).toBe(true);
  });

  it('rejects a variant carrying an unknown tag', () => {
    expect(variantSchema.safeParse({ raw: 'x', tag: 'middle(1)', parensStripped: true }).success).toBe(false);
  });

  it('rejects a variant missing parensStripped', () => {
    expect(variantSchema.safeParse({ raw: 'x', tag: 'full' }).success).toBe(false);
  });
});

describe('titleVariantsDebug schemas (#2096)', () => {
  it('trims the request title and enforces the 1-1024 bound', () => {
    const parsed = titleVariantsDebugBodySchema.safeParse({ title: '  Chapterhouse: Dune  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.title).toBe('Chapterhouse: Dune');
    expect(titleVariantsDebugBodySchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: '' }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({}).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'x'.repeat(1025) }).success).toBe(false);
    expect(titleVariantsDebugBodySchema.safeParse({ title: 'x'.repeat(1024) }).success).toBe(true);
  });

  it('composes variantSchema into the response envelope', () => {
    const parsed = titleVariantsDebugResponseSchema.safeParse({
      input: 'Foo: Subtitle',
      full: 'foo subtitle',
      variants: [{ raw: 'foo subtitle', tag: 'full', parensStripped: false }],
    });
    expect(parsed.success).toBe(true);
    expect(
      titleVariantsDebugResponseSchema.safeParse({
        input: 'x',
        full: '',
        variants: [{ raw: 'x', tag: 'nope', parensStripped: false }],
      }).success,
    ).toBe(false);
  });

  it('accepts the zero-variant arm', () => {
    expect(titleVariantsDebugResponseSchema.safeParse({ input: '[ ]', full: '', variants: [] }).success).toBe(true);
  });
});

describe('core ↔ shared type-contract drift guards (#2096)', () => {
  // TWO guards, one per exported type name. The second is NOT redundant:
  // `Variant.tag` resolves through SHARED's `VariantTag`, so a core module that
  // hand-writes only `VariantTag` while still re-exporting `Variant` leaves
  // `Equals<Variant, CoreVariant>` true and would compile clean against a
  // `Variant`-only guard.
  //
  // Verified standing of these guards (mutation-checked, both directions):
  // BOTH fire under their drift — but neither fires ALONE. `title-variants.ts`
  // builds its result through a `push` helper whose `tag` parameter is the
  // shared `VariantTag` and whose object literal lands in a shared `Variant[]`,
  // so the module's own typecheck rejects every divergence first — narrower,
  // wider, or field-dropping alike. These guards are therefore a backstop that
  // becomes the sole observation point only if that internal bridge is ever
  // refactored away; they are sound (they DO fail against the drifted code),
  // just not currently the first thing to fail.
  it('core Variant is still the shared Variant', () => {
    const aligned: Equals<Variant, CoreVariant> = true;
    expect(aligned).toBe(true);
  });

  it('core VariantTag is still the shared VariantTag', () => {
    const aligned: Equals<VariantTag, CoreVariantTag> = true;
    expect(aligned).toBe(true);
  });
});
