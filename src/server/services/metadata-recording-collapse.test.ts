import { describe, expect, it } from 'vitest';
import type { BookMetadata } from '@core/index.js';
import {
  collapseDuplicateRecordings,
  mergeAlternateAsins,
  selectCanonicalRecording,
  usefulArray,
  usefulString,
} from './metadata-recording-collapse.js';

/**
 * The selector is pure over ANY candidate array — the eligibility gate lives in the caller. That
 * wider domain is what makes the AC9a exclusions observable: inputs the collapse gate would refuse
 * still reach this function directly, so a field wrongly added to the richness list shows up here.
 */
describe('selectCanonicalRecording (#2219)', () => {
  function listing(asin: string, overrides: Partial<BookMetadata> = {}): BookMetadata {
    return {
      title: 'Bear Head',
      authors: [{ name: 'Adrian Tchaikovsky' }],
      asin,
      duration: 777,
      narrators: ['Sophie Aldred', 'Mark Elstob', 'Ben Allen'],
      ...overrides,
    };
  }

  describe('AC9.1 — the requested ASIN', () => {
    it('the member matching the input ASIN wins over a richer peer and over the smaller ASIN', () => {
      const richer = listing('B_AAA', { coverUrl: 'https://example.com/a.jpg', description: 'Blurb' });
      const requested = listing('B_ZZZ');

      expect(selectCanonicalRecording([richer, requested], 'B_ZZZ')).toBe(requested);
    });

    it('the comparison canonicalizes both sides, so a case-drifted and padded input ASIN still names it', () => {
      const other = listing('B_AAA');
      const requested = listing('  b_zzz  ');

      expect(selectCanonicalRecording([other, requested], ' b_ZzZ ')).toBe(requested);
    });

    it('an input ASIN that canonicalizes to null is ignored, and ranking proceeds', () => {
      const richer = listing('B_ZZZ', { publisher: 'Tor' });
      const plain = listing('B_AAA');

      expect(selectCanonicalRecording([richer, plain], '   ')).toBe(richer);
      expect(selectCanonicalRecording([richer, plain], undefined)).toBe(richer);
    });

    it('an input ASIN absent from the set is ignored, and ranking proceeds', () => {
      const richer = listing('B_ZZZ', { publisher: 'Tor' });
      const plain = listing('B_AAA');

      expect(selectCanonicalRecording([richer, plain], 'B_ELSEWHERE')).toBe(richer);
    });
  });

  describe('AC9a — fields deliberately excluded from the richness list', () => {
    // Every member of a COLLAPSIBLE set carries narrator signal by construction, so this input is
    // unreachable through resolveBook. Asserting it here is the only observation point at which
    // restoring `narrators` to the fixed list is visible: `usefulArray` is binary, so two non-blank
    // arrays of different length score identically and would prove nothing.
    it('narrators are not a richness field: the narrator-less candidate still wins the ASIN tie-break', () => {
      const narratorBearing = listing('B_ZZZ', { narrators: ['Jim Dale'] });
      const narratorLess = listing('B_AAA', { narrators: [] });

      expect(selectCanonicalRecording([narratorBearing, narratorLess], undefined)).toBe(narratorLess);
    });

    it.each([
      ['duration', 'B_ZZZ', { duration: 777 }, 'B_AAA', { duration: undefined }],
      ['asin presence', 'B_ZZZ', {}, '', {}],
    ])('%s is not a richness field', (_label, richAsin, richShape, plainAsin, plainShape) => {
      const bearing = listing(richAsin, richShape);
      const lacking = listing(plainAsin, plainShape);

      expect(selectCanonicalRecording([bearing, lacking], undefined)).toBe(lacking);
    });
  });

  describe('AC9.4 — the total tie-break', () => {
    it('two equally rich candidates fall to the smallest canonical ASIN, from either input order', () => {
      const small = listing('B_AAA');
      const large = listing('B_ZZZ');

      expect(selectCanonicalRecording([small, large], undefined)).toBe(small);
      expect(selectCanonicalRecording([large, small], undefined)).toBe(small);
    });

    it('the tie-break canonicalizes, so case does not decide the order', () => {
      const small = listing('b_aaa');
      const large = listing('B_ZZZ');

      expect(selectCanonicalRecording([large, small], undefined)).toBe(small);
    });
  });

  describe('AC10 — no merge', () => {
    it('the winner is returned by reference, carrying none of its peer’s fields', () => {
      const winner = listing('B_ZZZ', { coverUrl: 'https://example.com/z.jpg', description: 'Blurb' });
      const loser = listing('B_AAA', { publisher: 'Tor' });

      const result = selectCanonicalRecording([winner, loser], undefined);

      expect(result).toBe(winner);
      expect(result).not.toHaveProperty('publisher');
      expect(result.genres).toBeUndefined();
    });
  });
});

describe('usefulString / usefulArray (#2219 AC9)', () => {
  it.each([
    ['a plain value', 'Tor', true],
    ['a value with surrounding whitespace', '  Tor  ', true],
    ['the empty string', '', false],
    ['a whitespace-only value', '   ', false],
    ['a tab-and-newline-only value', '\t\n', false],
    ['undefined', undefined, false],
    ['null', null, false],
    ['a number', 7, false],
  ])('usefulString: %s', (_label, value, expected) => {
    expect(usefulString(value)).toBe(expected);
  });

  it.each([
    ['an array with one real entry', ['Fantasy'], true],
    ['an array mixing blanks and a real entry', ['   ', 'Fantasy'], true],
    ['an empty array', [], false],
    ['an array of blanks', ['   ', ''], false],
    ['undefined', undefined, false],
    ['a bare string', 'Fantasy', false],
  ])('usefulArray: %s', (_label, value, expected) => {
    expect(usefulArray(value)).toBe(expected);
  });
});

describe('mergeAlternateAsins (#1597 AC6)', () => {
  function member(asin: string | undefined, alternateAsins?: string[]): BookMetadata {
    return {
      title: 'Tideborn',
      authors: [{ name: 'Eliza Chan' }],
      ...(asin !== undefined && { asin }),
      ...(alternateAsins !== undefined && { alternateAsins }),
    };
  }

  it('carries every peer ASIN onto the canonical', () => {
    const canonical = member('B0DMTHDKGK');
    const peer = member('B0D9HK2KR4');

    expect(mergeAlternateAsins(canonical, [canonical, peer]).alternateAsins).toEqual(['B0D9HK2KR4']);
  });

  it('unions the pre-existing alternateAsins of every member, canonical included', () => {
    const canonical = member('B_CANON', ['B_OLD1']);
    const peer = member('B_PEER', ['B_OLD2']);

    expect(mergeAlternateAsins(canonical, [canonical, peer]).alternateAsins)
      .toEqual(['B_OLD1', 'B_OLD2', 'B_PEER']);
  });

  it('deduplicates across members and canonicalizes case and padding', () => {
    const canonical = member('B_CANON', ['b_dupe']);
    const peer = member('  B_PEER  ', ['B_DUPE', ' b_peer ']);

    expect(mergeAlternateAsins(canonical, [canonical, peer]).alternateAsins).toEqual(['B_DUPE', 'B_PEER']);
  });

  it('never lists the canonical’s own ASIN, however it was spelled on a peer', () => {
    const canonical = member('B_CANON');
    const peer = member('B_PEER', ['  b_canon  ']);

    expect(mergeAlternateAsins(canonical, [canonical, peer]).alternateAsins).toEqual(['B_PEER']);
  });

  it('drops unusable ASINs rather than emitting blanks', () => {
    const canonical = member('B_CANON');
    const peer = member('   ', ['', 'B_REAL']);

    expect(mergeAlternateAsins(canonical, [canonical, peer]).alternateAsins).toEqual(['B_REAL']);
  });

  it('returns the canonical by reference when nothing would be added', () => {
    const canonical = member('B_CANON');

    expect(mergeAlternateAsins(canonical, [canonical])).toBe(canonical);
  });

  it('does not mutate the canonical', () => {
    const canonical = member('B_CANON');
    mergeAlternateAsins(canonical, [canonical, member('B_PEER')]);

    expect(canonical).not.toHaveProperty('alternateAsins');
  });

  it('sorts the result, so provider order cannot change it', () => {
    const canonical = member('B_CANON');
    const first = member('B_ZZZ');
    const second = member('B_AAA');

    expect(mergeAlternateAsins(canonical, [canonical, first, second]).alternateAsins)
      .toEqual(mergeAlternateAsins(canonical, [canonical, second, first]).alternateAsins);
    expect(mergeAlternateAsins(canonical, [canonical, first, second]).alternateAsins).toEqual(['B_AAA', 'B_ZZZ']);
  });
});

/**
 * The Tideborn specimen (#1597): Orbit US `B0D9HK2KR4` and Little, Brown UK `B0DMTHDKGK` are one
 * 755-minute Emily Woo Zeller recording, and only the UK listing carries the series mapping.
 */
describe('collapseDuplicateRecordings (#1597)', () => {
  const CHAN = 'Eliza Chan';
  const ZELLER = ['Emily Woo Zeller'];
  /** `BookMetadata.duration` is MINUTES; 755 is the live runtime on both Tideborn listings. */
  const TIDEBORN_MINUTES = 755;

  function edition(asin: string, overrides: Partial<BookMetadata> = {}): BookMetadata {
    return {
      title: 'Tideborn',
      authors: [{ name: CHAN }],
      asin,
      duration: TIDEBORN_MINUTES,
      narrators: ZELLER,
      formatType: 'unabridged',
      ...overrides,
    };
  }

  const US = edition('B0D9HK2KR4');
  const UK = edition('B0DMTHDKGK', { series: [{ name: 'Drowned World', position: 2 }] });

  describe('AC1/AC5/AC6 — the Tideborn pair', () => {
    it('collapses to the series-bearing record, carrying its twin’s ASIN', () => {
      const { books } = collapseDuplicateRecordings([US, UK]);

      expect(books).toHaveLength(1);
      expect(books[0]?.asin).toBe('B0DMTHDKGK');
      expect(books[0]?.series).toEqual([{ name: 'Drowned World', position: 2 }]);
      expect(books[0]?.alternateAsins).toEqual(['B0D9HK2KR4']);
    });

    it('picks the same canonical from either provider order', () => {
      expect(collapseDuplicateRecordings([UK, US]).books[0]?.asin).toBe('B0DMTHDKGK');
      expect(collapseDuplicateRecordings([US, UK]).books[0]?.asin).toBe('B0DMTHDKGK');
    });

    it('reports the collapse for the AC10 log line, with the peers sorted', () => {
      expect(collapseDuplicateRecordings([UK, US]).collapses).toEqual([
        { canonicalAsin: 'B0DMTHDKGK', collapsedAsins: ['B0D9HK2KR4'] },
      ]);
    });

    it('leaves the inputs untouched', () => {
      collapseDuplicateRecordings([US, UK]);

      expect(US).not.toHaveProperty('alternateAsins');
      expect(UK).not.toHaveProperty('alternateAsins');
    });
  });

  describe('AC4 — distinct recordings always survive', () => {
    it('a third recording with a different narrator set yields two entries, not one', () => {
      const otherNarration = edition('B_OTHERNARR', { narrators: ['Natalie Naudus'] });

      const { books } = collapseDuplicateRecordings([US, UK, otherNarration]);

      expect(books.map((b) => b.asin)).toEqual(['B0DMTHDKGK', 'B_OTHERNARR']);
      expect(books[1]).toBe(otherNarration);
    });

    it('an abridged listing never shares a bucket with its unabridged twin', () => {
      const abridged = edition('B_ABRIDGED', { formatType: 'abridged' });

      const { books, collapses } = collapseDuplicateRecordings([US, abridged]);

      expect(books).toEqual([US, abridged]);
      expect(collapses).toEqual([]);
    });

    // The bucket key is a partition, so an unknown production form splits before the primitive's
    // one-sided-unknown tolerance can apply. Two cards is the accepted failure mode here.
    it('an unknown production form on one side splits the bucket rather than collapsing', () => {
      const unknownForm = edition('B_UNKNOWNFORM', { formatType: undefined });

      expect(collapseDuplicateRecordings([US, unknownForm]).collapses).toEqual([]);
    });

    it('a different author splits the bucket', () => {
      const otherAuthor = edition('B_OTHERAUTH', { authors: [{ name: 'Someone Else' }] });

      expect(collapseDuplicateRecordings([US, otherAuthor]).books).toHaveLength(2);
    });

    it('an out-of-band runtime is refused by the primitive even inside one bucket', () => {
      // 755 vs 761 minutes is 360s apart — beyond the primitive's 240s band.
      const longer = edition('B_LONGER', { duration: 761 });

      expect(collapseDuplicateRecordings([US, longer]).collapses).toEqual([]);
    });
  });

  describe('AC3 — the bucket is decided all-or-nothing', () => {
    it('the non-transitive 600/604/608 chain collapses nothing at all', () => {
      const chain = [
        edition('B_D600', { duration: 600 }),
        edition('B_D604', { duration: 604 }),
        edition('B_D608', { duration: 608 }),
      ];

      const { books, collapses } = collapseDuplicateRecordings(chain);

      expect(books).toEqual(chain);
      expect(collapses).toEqual([]);
    });

    it.each([
      ['no canonicalizable ASIN', { asin: '   ' }],
      ['no duration', { duration: undefined }],
      ['a zero duration', { duration: 0 }],
      ['no narrators', { narrators: undefined }],
      ['an empty narrator array', { narrators: [] }],
    ])('an entry with %s passes through beside its would-be twin', (_label, shape) => {
      const ineligible = edition('B_INELIGIBLE', shape);
      const input = [US, ineligible];

      const { books, collapses } = collapseDuplicateRecordings(input);

      expect(books).toEqual(input);
      expect(collapses).toEqual([]);
    });

    it('one ineligible member does not stop a separate bucket from collapsing', () => {
      const orphan = edition('B_ORPHAN', { narrators: ['Solo Reader'], duration: undefined });

      const { books } = collapseDuplicateRecordings([orphan, US, UK]);

      expect(books.map((b) => b.asin)).toEqual(['B_ORPHAN', 'B0DMTHDKGK']);
    });
  });

  describe('AC5 — canonical selection is the existing rule', () => {
    it('richness decides when neither listing bears a series', () => {
      const richer = edition('B_ZZZ', { coverUrl: 'https://example.com/z.jpg', description: 'Blurb' });
      const plain = edition('B_AAA');

      expect(collapseDuplicateRecordings([plain, richer]).books[0]?.asin).toBe('B_ZZZ');
    });

    it('an equal-richness tie falls to the smallest canonical ASIN', () => {
      expect(collapseDuplicateRecordings([edition('B_ZZZ'), edition('B_AAA')]).books[0]?.asin).toBe('B_AAA');
    });

    it('a preferred ASIN overrides the ranking for the resolver call site', () => {
      const richer = edition('B_ZZZ', { coverUrl: 'https://example.com/z.jpg', description: 'Blurb' });
      const plain = edition('B_AAA');

      expect(collapseDuplicateRecordings([richer, plain], 'b_aaa').books[0]?.asin).toBe('B_AAA');
    });
  });

  describe('ordering and pass-through', () => {
    it('the collapsed group keeps the earliest slot its members held', () => {
      const unrelated = edition('B_UNRELATED', { title: 'Fathomfolk', narrators: ['Eileen Wu'] });

      const { books } = collapseDuplicateRecordings([US, unrelated, UK]);

      expect(books.map((b) => b.asin)).toEqual(['B0DMTHDKGK', 'B_UNRELATED']);
    });

    it.each([
      ['an empty list', []],
      ['a singleton', [US]],
    ])('%s passes through by reference', (_label, input) => {
      const { books, collapses } = collapseDuplicateRecordings(input);

      expect(books).toBe(input);
      expect(collapses).toEqual([]);
    });

    it('a list with nothing to collapse passes through by reference', () => {
      const input = [US, edition('B_OTHER', { narrators: ['Natalie Naudus'] })];

      expect(collapseDuplicateRecordings(input).books).toBe(input);
    });
  });
});
