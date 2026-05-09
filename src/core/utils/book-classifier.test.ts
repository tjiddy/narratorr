import { describe, it, expect } from 'vitest';
import { classifyLeafFolder, hasStrongChapterSetEvidence, type ClassifierFile } from './book-classifier.js';
import { BYTES_PER_MB } from '../../shared/constants.js';

const LARGE = 300 * BYTES_PER_MB;
const SMALL = 30 * BYTES_PER_MB;
const SHORT_STORY = 50 * BYTES_PER_MB;

function files(specs: { path: string; size: number }[]): ClassifierFile[] {
  return specs;
}

function uniformLarge(paths: string[]): ClassifierFile[] {
  return paths.map(p => ({ path: p, size: LARGE }));
}

describe('classifyLeafFolder', () => {
  describe('decision-rule scenario table (issue #1016)', () => {
    it('1: distinct large named files split as N books', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Mistborn Trilogy/Mistborn 01 - The Final Empire.mp3',
        '/lib/Mistborn Trilogy/Mistborn 02 - The Well of Ascension.mp3',
        '/lib/Mistborn Trilogy/Mistborn 03 - The Hero of Ages.mp3',
      ]));
      expect(result).toEqual({
        decision: 'split',
        reason: 'distinct-large-files-no-marker',
        sizeEvidence: { largeCount: 3, largeRatio: 1 },
      });
    });

    it('2: 30 chapter-prefixed files merge', () => {
      const paths = Array.from({ length: 30 }, (_, i) =>
        `/lib/Book/Chapter ${String(i + 1).padStart(2, '0')} - Title ${i + 1}.mp3`,
      );
      const result = classifyLeafFolder(paths.map(p => ({ path: p, size: SMALL })));
      expect(result).toEqual({ decision: 'merge', reason: 'chapter-disc-part-marker' });
    });

    it('3: 30 bare-Chapter NN files merge', () => {
      const paths = Array.from({ length: 30 }, (_, i) =>
        `/lib/Book/Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
      );
      const result = classifyLeafFolder(paths.map(p => ({ path: p, size: SMALL })));
      expect(result).toEqual({ decision: 'merge', reason: 'chapter-disc-part-marker' });
    });

    it('4: numeric-only stems merge', () => {
      const paths = Array.from({ length: 30 }, (_, i) =>
        `/lib/Book/${String(i + 1).padStart(2, '0')}.mp3`,
      );
      const result = classifyLeafFolder(paths.map(p => ({ path: p, size: SMALL })));
      expect(result).toEqual({ decision: 'merge', reason: 'numeric-only-stems' });
    });

    it('5: BookTitle - Disc 0N merges (chapter-disc-part-marker)', () => {
      const paths = Array.from({ length: 12 }, (_, i) =>
        `/lib/Book/BookTitle - Disc ${String(i + 1).padStart(2, '0')}.mp3`,
      );
      const result = classifyLeafFolder(paths.map(p => ({ path: p, size: 600 * BYTES_PER_MB })));
      expect(result).toEqual({ decision: 'merge', reason: 'chapter-disc-part-marker' });
    });

    it('6: BookTitle - Part N merges (chapter-disc-part-marker)', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Book/BookTitle - Part 1.mp3',
        '/lib/Book/BookTitle - Part 2.mp3',
        '/lib/Book/BookTitle - Part 3.mp3',
      ]).map(f => ({ ...f, size: 150 * BYTES_PER_MB })));
      expect(result).toEqual({ decision: 'merge', reason: 'chapter-disc-part-marker' });
    });

    it('7: parenthesized duplicates merge (duplicate-normalized-stems)', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Book/BookTitle.mp3',
        '/lib/Book/BookTitle (2).mp3',
        '/lib/Book/BookTitle (3).mp3',
      ]));
      expect(result).toEqual({ decision: 'merge', reason: 'duplicate-normalized-stems' });
    });

    it('8: Mistborn 0N (no subtitle) collides on duplicate-normalized-stems', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Mistborn Trilogy/Mistborn 01.mp3',
        '/lib/Mistborn Trilogy/Mistborn 02.mp3',
        '/lib/Mistborn Trilogy/Mistborn 03.mp3',
      ]));
      expect(result).toEqual({ decision: 'merge', reason: 'duplicate-normalized-stems' });
    });

    it('9: Bk1/Bk2/Bk3 distinct stems but lack title content', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Book/Bk1.mp3',
        '/lib/Book/Bk2.mp3',
        '/lib/Book/Bk3.mp3',
      ]));
      expect(result).toEqual({ decision: 'merge', reason: 'normalized-stem-lacks-title-content' });
    });

    it('10: short story collection (too small for full books)', () => {
      const result = classifyLeafFolder([
        { path: '/lib/Stories/Story One.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Two.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Three.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Four.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Five.mp3', size: SHORT_STORY },
      ]);
      expect(result).toEqual({ decision: 'merge', reason: 'files-too-small-for-full-books' });
    });

    it('11: 13-book flat pack with distinct titles splits', () => {
      const titles = [
        'The Final Empire', 'The Well of Ascension', 'The Hero of Ages',
        'The Alloy of Law', 'Shadows of Self', 'The Bands of Mourning',
        'The Lost Metal', 'Warbreaker', 'Elantris',
        'Tress of the Emerald Sea', 'The Sunlit Man', 'Yumi and the Nightmare Painter',
        'The Frugal Wizards Handbook',
      ];
      const result = classifyLeafFolder(uniformLarge(
        titles.map(t => `/lib/Sanderson/${t}.mp3`),
      ));
      expect(result).toEqual({
        decision: 'split',
        reason: 'distinct-large-files-no-marker',
        sizeEvidence: { largeCount: 13, largeRatio: 1 },
      });
    });

    it('12: 50 distinct large files exceed split cap', () => {
      const paths = Array.from({ length: 50 }, (_, i) => `/lib/Pack/Book ${i + 1} - Title ${i + 1}.mp3`);
      const result = classifyLeafFolder(uniformLarge(paths));
      expect(result).toEqual({ decision: 'merge', reason: 'count-exceeds-cap' });
    });
  });

  describe('MERGE_MARKER_RE regression cases', () => {
    it.each(['Disc01', 'Disk01', 'CD01', 'Track01', 'Part01', 'Chap01'])(
      'matches "%s" (no separator between marker and digit)',
      (stem) => {
        const result = classifyLeafFolder(uniformLarge([
          `/lib/Book/${stem}.mp3`,
          `/lib/Book/${stem}-other.mp3`,
        ]));
        expect(result.decision).toBe('merge');
        expect(result.reason).toBe('chapter-disc-part-marker');
      },
    );

    it.each(['BookTitle.mp3', 'Story Book 1.mp3', 'Volume 1.mp3'])(
      'does NOT match "%s" (bare book/volume without separator-prefix is not a marker)',
      (filename) => {
        // Pair with a duplicate-shaped sibling so we can observe that the marker
        // guard did NOT short-circuit. Since both files normalize the same way,
        // we land in duplicate-normalized-stems — but only because the marker
        // guard correctly let the pipeline continue.
        const result = classifyLeafFolder(uniformLarge([
          `/lib/Book/${filename}`,
          `/lib/Book/${filename.replace('.mp3', ' (2).mp3')}`,
        ]));
        expect(result.reason).not.toBe('chapter-disc-part-marker');
      },
    );
  });

  describe('boundary edges', () => {
    it('count = 0 → merge (single-file)', () => {
      expect(classifyLeafFolder([])).toEqual({ decision: 'merge', reason: 'single-file' });
    });

    it('count = 1 → merge (single-file)', () => {
      expect(classifyLeafFolder([{ path: '/lib/Book/only.mp3', size: LARGE }]))
        .toEqual({ decision: 'merge', reason: 'single-file' });
    });

    it('count = 30 with split-eligible files → split (cap is inclusive)', () => {
      // Use distinct stems so duplicate-normalized-stems doesn't fire
      const paths = Array.from({ length: 30 }, (_, i) => `/lib/Pack/UniqueBook${i}.mp3`);
      const result = classifyLeafFolder(uniformLarge(paths));
      expect(result).toEqual({
        decision: 'split',
        reason: 'distinct-large-files-no-marker',
        sizeEvidence: { largeCount: 30, largeRatio: 1 },
      });
    });

    it('count = 31 with split-eligible files → merge (count-exceeds-cap)', () => {
      const paths = Array.from({ length: 31 }, (_, i) => `/lib/Pack/UniqueBook${i}.mp3`);
      const result = classifyLeafFolder(uniformLarge(paths));
      expect(result).toEqual({ decision: 'merge', reason: 'count-exceeds-cap' });
    });

    it('exactly 80% large files passes the size guard (boundary inclusive)', () => {
      // 4 of 5 large = 80%. Unique stems so we land on split.
      const result = classifyLeafFolder(files([
        { path: '/lib/Pack/StoryAlpha.mp3', size: LARGE },
        { path: '/lib/Pack/StoryBeta.mp3', size: LARGE },
        { path: '/lib/Pack/StoryGamma.mp3', size: LARGE },
        { path: '/lib/Pack/StoryDelta.mp3', size: LARGE },
        { path: '/lib/Pack/StoryEpsilon.mp3', size: SHORT_STORY },
      ]));
      expect(result).toEqual({
        decision: 'split',
        reason: 'distinct-large-files-no-marker',
        sizeEvidence: { largeCount: 4, largeRatio: 0.8 },
      });
    });

    // Behavioral flip from #1035: under the old single-ratio guard 60% large
    // merged. The new condition 2 (largeCount ≥ 3 AND largeRatio ≥ 0.5)
    // catches mixed-size series collections so 3-of-5 large now splits.
    it('60% large files now splits via condition 2 (3 large, 0.6 ratio)', () => {
      const result = classifyLeafFolder(files([
        { path: '/lib/Pack/StoryAlpha.mp3', size: LARGE },
        { path: '/lib/Pack/StoryBeta.mp3', size: LARGE },
        { path: '/lib/Pack/StoryGamma.mp3', size: LARGE },
        { path: '/lib/Pack/StoryDelta.mp3', size: SHORT_STORY },
        { path: '/lib/Pack/StoryEpsilon.mp3', size: SHORT_STORY },
      ]));
      expect(result).toEqual({
        decision: 'split',
        reason: 'distinct-large-files-no-marker',
        sizeEvidence: { largeCount: 3, largeRatio: 0.6 },
      });
    });
  });

  describe('three-condition size evidence (issue #1035)', () => {
    // ratio ≥ 0.8 path is exercised by the Mistborn trilogy test (case 1).

    it('AC5: Reacher (21 large + 7 small distinct stems) splits with raw sizeEvidence', () => {
      const novels = [
        'Killing Floor', 'Die Trying', 'Tripwire', 'Running Blind', 'Echo Burning',
        'Without Fail', 'Persuader', 'The Enemy', 'One Shot', 'The Hard Way',
        'Bad Luck and Trouble', 'Nothing to Lose', 'Gone Tomorrow', '61 Hours',
        'Worth Dying For', 'The Affair', 'A Wanted Man', 'Never Go Back',
        'Personal', 'Make Me', 'Night School',
      ];
      const novellas = [
        'Second Son', 'Deep Down', 'High Heat', 'Not a Drill', 'Small Wars',
        'James Penney', 'Everyone Talks Too Much',
      ];
      const result = classifyLeafFolder([
        ...novels.map(t => ({ path: `/lib/Reacher/${t}.mp3`, size: LARGE })),
        ...novellas.map(t => ({ path: `/lib/Reacher/${t}.mp3`, size: SHORT_STORY })),
      ]);
      expect(result.decision).toBe('split');
      expect(result.reason).toBe('distinct-large-files-no-marker');
      expect(result.sizeEvidence?.largeCount).toBe(21);
      expect(result.sizeEvidence?.largeRatio).toBeCloseTo(21 / 28);
    });

    // AC6 is covered by "60% large files now splits via condition 2" above.

    it('AC7: 25 files, 10 large + 15 small splits via condition 3 (floor)', () => {
      const large = Array.from({ length: 10 }, (_, i) => ({
        path: `/lib/Big/Novel ${String.fromCharCode(65 + i)}.mp3`,
        size: LARGE,
      }));
      const small = Array.from({ length: 15 }, (_, i) => ({
        path: `/lib/Big/Story-${i}.mp3`,
        size: SHORT_STORY,
      }));
      const result = classifyLeafFolder([...large, ...small]);
      expect(result).toEqual({
        decision: 'split',
        reason: 'distinct-large-files-no-marker',
        sizeEvidence: { largeCount: 10, largeRatio: 10 / 25 },
      });
    });

    it('AC8: 25 files, 9 large + 16 small merges (floor counter-test)', () => {
      const large = Array.from({ length: 9 }, (_, i) => ({
        path: `/lib/Big/Novel ${String.fromCharCode(65 + i)}.mp3`,
        size: LARGE,
      }));
      const small = Array.from({ length: 16 }, (_, i) => ({
        path: `/lib/Big/Story-${i}.mp3`,
        size: SHORT_STORY,
      }));
      const result = classifyLeafFolder([...large, ...small]);
      expect(result.decision).toBe('merge');
      expect(result.reason).toBe('files-too-small-for-full-books');
    });

    it('AC9: ratio exactly 0.5 with 3 large splits via condition 2 (boundary inclusive)', () => {
      const result = classifyLeafFolder(files([
        { path: '/lib/Mid/Alpha.mp3', size: LARGE },
        { path: '/lib/Mid/Beta.mp3', size: LARGE },
        { path: '/lib/Mid/Gamma.mp3', size: LARGE },
        { path: '/lib/Mid/Delta.mp3', size: SHORT_STORY },
        { path: '/lib/Mid/Epsilon.mp3', size: SHORT_STORY },
        { path: '/lib/Mid/Zeta.mp3', size: SHORT_STORY },
      ]));
      expect(result).toEqual({
        decision: 'split',
        reason: 'distinct-large-files-no-marker',
        sizeEvidence: { largeCount: 3, largeRatio: 0.5 },
      });
    });

    it('AC11: 30 small distinct titleful stems with no marker merges', () => {
      const result = classifyLeafFolder(
        Array.from({ length: 30 }, (_, i) => ({
          path: `/lib/HP/UniqueTitle${i}.mp3`,
          size: SHORT_STORY,
        })),
      );
      expect(result.decision).toBe('merge');
      expect(result.reason).toBe('files-too-small-for-full-books');
    });

    it('AC13: 1 large + 1 small (tiny ambiguous) merges', () => {
      const result = classifyLeafFolder(files([
        { path: '/lib/Two/Alpha.mp3', size: LARGE },
        { path: '/lib/Two/Beta.mp3', size: SHORT_STORY },
      ]));
      expect(result.decision).toBe('merge');
      expect(result.reason).toBe('files-too-small-for-full-books');
    });

    it('AC18: 2 of 4 large (counter-test) merges', () => {
      const result = classifyLeafFolder(files([
        { path: '/lib/Four/Alpha.mp3', size: LARGE },
        { path: '/lib/Four/Beta.mp3', size: LARGE },
        { path: '/lib/Four/Gamma.mp3', size: SHORT_STORY },
        { path: '/lib/Four/Delta.mp3', size: SHORT_STORY },
      ]));
      expect(result.decision).toBe('merge');
      expect(result.reason).toBe('files-too-small-for-full-books');
    });
  });

  describe('guard precedence vs size evidence (issue #1035)', () => {
    it('AC14: duplicate-stems fires before size when 21 of 28 are large but stems normalize to "Reacher"', () => {
      const result = classifyLeafFolder(
        Array.from({ length: 28 }, (_, i) => ({
          path: `/lib/Reacher/Reacher ${String(i + 1).padStart(2, '0')}.mp3`,
          size: i < 21 ? LARGE : SHORT_STORY,
        })),
      );
      expect(result).toEqual({ decision: 'merge', reason: 'duplicate-normalized-stems' });
    });

    it('AC15: marker fires before size when stems contain "Chapter N" and sizes mixed', () => {
      const result = classifyLeafFolder(
        Array.from({ length: 28 }, (_, i) => ({
          path: `/lib/Mixed/Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
          size: i < 21 ? LARGE : SHORT_STORY,
        })),
      );
      expect(result).toEqual({ decision: 'merge', reason: 'chapter-disc-part-marker' });
    });

    it('AC16: title-content fires before size when 5 large files normalize to <3 alpha stems', () => {
      // After normalizeStemForComparison strips trailing " <digits>", each stem
      // is two alpha chars (Aa, Bb, …) — distinct lowercased and not a marker
      // keyword, so this guard exercises the title-content branch in isolation.
      const result = classifyLeafFolder(files([
        { path: '/lib/Tiny/Aa 01.mp3', size: 200 * BYTES_PER_MB },
        { path: '/lib/Tiny/Bb 02.mp3', size: 200 * BYTES_PER_MB },
        { path: '/lib/Tiny/Cc 03.mp3', size: 200 * BYTES_PER_MB },
        { path: '/lib/Tiny/Dd 04.mp3', size: 200 * BYTES_PER_MB },
        { path: '/lib/Tiny/Ee 05.mp3', size: 200 * BYTES_PER_MB },
      ]));
      expect(result).toEqual({ decision: 'merge', reason: 'normalized-stem-lacks-title-content' });
    });
  });

  describe('AC2: marker rule tightening (#1048)', () => {
    // Pre-#1048 the marker check used `.some()`: a single stray "Part 1" /
    // "Disc N" / "CD N" / "Chapter N" in any one stem caused the entire batch
    // to merge. Real titles routinely contain these substrings ("Sixth Realm
    // Part 1", "Resident Evil CD 2 Edition"). Post-#1048: ALL stems must
    // match MERGE_MARKER_RE AND share a markerless prefix.

    it('does NOT merge when only some stems carry markers', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Pack/Sixth Realm Part 1.mp3',
        '/lib/Pack/Other Standalone Title.mp3',
      ]));
      expect(result.reason).not.toBe('chapter-disc-part-marker');
    });

    it('does NOT merge when all stems have markers but markerless prefixes differ', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Pack/Book A Part 1.mp3',
        '/lib/Pack/Book B Part 2.mp3',
      ]));
      expect(result.reason).not.toBe('chapter-disc-part-marker');
    });

    it('merges when all stems share a non-empty markerless prefix (true multi-disc)', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Book/Heir Disc 1.mp3',
        '/lib/Book/Heir Disc 2.mp3',
        '/lib/Book/Heir Disc 3.mp3',
      ]));
      expect(result.reason).toBe('chapter-disc-part-marker');
    });

    it('merges legitimate two-part book (audiobook Part 1, audiobook Part 2)', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Book/audiobook Part 1.mp3',
        '/lib/Book/audiobook Part 2.mp3',
      ]));
      expect(result.reason).toBe('chapter-disc-part-marker');
    });

    it('merges when all stems are bare Chapter NN (markerless prefix is empty → "shared")', () => {
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Book/Chapter 01.mp3',
        '/lib/Book/Chapter 02.mp3',
        '/lib/Book/Chapter 03.mp3',
      ]));
      expect(result.reason).toBe('chapter-disc-part-marker');
    });
  });

  describe('check-order regression', () => {
    it('duplicate-stem fires BEFORE title-content when both would match', () => {
      // Three files all normalizing to "Bk" — both guards (duplicate + title-content) would fire.
      // Order check pins duplicate-normalized-stems as the reported reason.
      const result = classifyLeafFolder(uniformLarge([
        '/lib/Book/a/Bk.mp3',
        '/lib/Book/b/Bk.mp3',
        '/lib/Book/c/Bk.mp3',
      ]));
      expect(result).toEqual({ decision: 'merge', reason: 'duplicate-normalized-stems' });
    });

    it('marker guard does NOT fire when only one stem has a marker (#1048 AC2)', () => {
      // Pre-#1048: a single stray "Chapter NN" stem in a batch of distinct
      // titles caused whole-batch merge via `.some()`. Post-#1048: marker rule
      // requires ALL stems to match AND share a markerless prefix, so this
      // batch falls through to the size guard.
      const result = classifyLeafFolder([
        { path: '/lib/Book/Chapter 01.mp3', size: SHORT_STORY },
        { path: '/lib/Book/Other Two.mp3', size: SHORT_STORY },
        { path: '/lib/Book/Other Three.mp3', size: SHORT_STORY },
      ]);
      expect(result).toEqual({ decision: 'merge', reason: 'files-too-small-for-full-books' });
    });

    it('count-cap fires before any other check', () => {
      // 31 chapter-marker files — would also fire chapter guard, but cap wins.
      const paths = Array.from({ length: 31 }, (_, i) => `/lib/Book/Chapter ${i + 1}.mp3`);
      const result = classifyLeafFolder(paths.map(p => ({ path: p, size: SMALL })));
      expect(result).toEqual({ decision: 'merge', reason: 'count-exceeds-cap' });
    });
  });
});

// `hasStrongChapterSetEvidence` is the predicate the mixed-content branch in
// book-discovery uses INSTEAD of `classifyLeafFolder` (#1048). It must NOT
// consult count caps, size heuristics, or any subset-duplicate signals — those
// safety nets are merge-biased on purpose for leaf folders, but catastrophic
// when applied to recursive subtree absorption.
describe('hasStrongChapterSetEvidence (#1048)', () => {
  describe('marker-set rule', () => {
    it('returns true for bare Chapter NN files (markerless prefix empty → "shared")', () => {
      const stems = Array.from({ length: 28 }, (_, i) => ({
        path: `/lib/Book/Chapter ${String(i + 1).padStart(2, '0')}.mp3`,
        size: SHORT_STORY,
      }));
      expect(hasStrongChapterSetEvidence(stems)).toBe(true);
    });

    it('returns true for shared-prefix multi-disc set', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/Mistborn Disc 1.mp3', size: 200 * BYTES_PER_MB },
        { path: '/lib/Book/Mistborn Disc 2.mp3', size: 200 * BYTES_PER_MB },
        { path: '/lib/Book/Mistborn Disc 3.mp3', size: 200 * BYTES_PER_MB },
      ])).toBe(true);
    });

    it('returns false when only some stems carry markers', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Pack/Sixth Realm Part 1.mp3', size: SHORT_STORY },
        { path: '/lib/Pack/Other Title.mp3', size: SHORT_STORY },
      ])).toBe(false);
    });

    it('returns false when all stems have markers but prefixes differ', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Pack/Book A Part 1.mp3', size: SHORT_STORY },
        { path: '/lib/Pack/Book B Part 2.mp3', size: SHORT_STORY },
      ])).toBe(false);
    });
  });

  describe('numeric-only rule', () => {
    it('returns true for digits-only stems', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/01.mp3', size: SHORT_STORY },
        { path: '/lib/Book/02.mp3', size: SHORT_STORY },
        { path: '/lib/Book/03.mp3', size: SHORT_STORY },
      ])).toBe(true);
    });
  });

  describe('strict all-same-stem rule (vs. classifier subset duplicate)', () => {
    it('returns true when EVERY normalized stem is identical and non-empty', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/Mistborn 01.mp3', size: LARGE },
        { path: '/lib/Book/Mistborn 02.mp3', size: LARGE },
        { path: '/lib/Book/Mistborn 03.mp3', size: LARGE },
      ])).toBe(true);
    });

    it('returns false on subset duplicates (Book A Part 1/2 + 20 unrelated)', () => {
      // Critical AC13 contrast: classifyLeafFolder's `distinct < count` would
      // mis-fire here (the two "Book A Part" stems normalize identically, so
      // distinct=21 < count=22). hasStrongChapterSetEvidence requires
      // distinct === 1 — every stem must collapse to the same value.
      const subsetDup: ClassifierFile[] = [
        { path: '/lib/Pack/Book A Part 1.m4b', size: 200 * BYTES_PER_MB },
        { path: '/lib/Pack/Book A Part 2.m4b', size: 200 * BYTES_PER_MB },
      ];
      const unrelated: ClassifierFile[] = Array.from({ length: 20 }, (_, i) => ({
        path: `/lib/Pack/Standalone Title ${i}.m4b`,
        size: 200 * BYTES_PER_MB,
      }));
      expect(hasStrongChapterSetEvidence([...subsetDup, ...unrelated])).toBe(false);
    });

    it('returns false on empty normalized stem (whitespace-only)', () => {
      // `Bk1`/`Bk2`/`Bk3` would normalize to `Bk` each — distinct, so no merge.
      // True empty-string collapse only happens in degenerate cases; pin that
      // an empty-stem all-same scenario does NOT fire (the lower-bound guard).
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/Bk1.mp3', size: LARGE },
        { path: '/lib/Book/Bk2.mp3', size: LARGE },
        { path: '/lib/Book/Bk3.mp3', size: LARGE },
      ])).toBe(false);
    });
  });

  describe('safety-net checks NOT consulted', () => {
    it('returns false on 37 distinct large no-marker stems (count cap NOT consulted)', () => {
      // The pre-#1048 leaf-classifier path returned merge with reason
      // count-exceeds-cap on count > 30. hasStrongChapterSetEvidence ignores
      // the cap entirely — distinct titles with no markers stay false.
      // Use genuinely distinct titles, not "Title NN" — `normalizeStemForComparison`
      // strips trailing ` \d+` and would collapse the latter to one stem.
      const titles = [
        'Killing Floor', 'Die Trying', 'Tripwire', 'Running Blind', 'Echo Burning',
        'Without Fail', 'Persuader', 'The Enemy', 'One Shot', 'The Hard Way',
        'Bad Luck and Trouble', 'Nothing to Lose', 'Gone Tomorrow', 'Worth Dying For',
        'The Affair', 'A Wanted Man', 'Never Go Back', 'Personal', 'Make Me',
        'Night School', 'No Middle Name', 'The Midnight Line', 'Past Tense',
        'Blue Moon', 'The Sentinel', 'Better Off Dead', 'No Plan B', 'The Secret',
        'In Too Deep', 'Second Son', 'Deep Down', 'High Heat', 'Not a Drill',
        'Small Wars', 'James Penney', 'Everyone Talks', 'The Christmas Scorpion',
      ];
      const stems = titles.map(t => ({ path: `/lib/Pack/${t}.m4b`, size: 200 * BYTES_PER_MB }));
      expect(stems).toHaveLength(37);
      expect(hasStrongChapterSetEvidence(stems)).toBe(false);
    });

    it('returns false on 5 small stories (size guard NOT consulted)', () => {
      // The leaf classifier would merge these (files-too-small-for-full-books).
      // The strict helper returns false because no positive evidence rule fires.
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Stories/Story One.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Two.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Three.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Four.mp3', size: SHORT_STORY },
        { path: '/lib/Stories/Story Five.mp3', size: SHORT_STORY },
      ])).toBe(false);
    });

    it('returns false on Bk1/Bk2/Bk3 (title-content guard NOT consulted)', () => {
      // The leaf classifier would merge these via normalized-stem-lacks-title-content.
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/Bk1.mp3', size: LARGE },
        { path: '/lib/Book/Bk2.mp3', size: LARGE },
        { path: '/lib/Book/Bk3.mp3', size: LARGE },
      ])).toBe(false);
    });
  });

  it('returns false for fewer than 2 files', () => {
    expect(hasStrongChapterSetEvidence([])).toBe(false);
    expect(hasStrongChapterSetEvidence([
      { path: '/lib/Book/single.mp3', size: LARGE },
    ])).toBe(false);
  });

  // The original #1031 test fixture used synthetic `Chapter NN.mp3` filenames
  // which match MERGE_MARKER_RE and pass via the marker-set rule — masking the
  // fact that real-world torrent naming overwhelmingly uses
  // `<digits><space><title>` (no "Chapter" keyword), which the marker rule and
  // the normalizer's `[-_.]`-only separator strip both miss. The rule below
  // pins the realistic shape so this regression class doesn't slip through
  // again. NEW chapter-encoded fixtures MUST use real-world torrent naming
  // patterns, not synthetic marker-keyword filenames.
  describe('leading-numeric-prefix shared-title rule (#1051)', () => {
    it('AC1: real-world Heir filenames "01 Heir to the Empire" through "28 Heir to the Empire" → true', () => {
      const stems = Array.from({ length: 28 }, (_, i) => ({
        path: `/lib/Book/${String(i + 1).padStart(2, '0')} Heir to the Empire.mp3`,
        size: SHORT_STORY,
      }));
      expect(hasStrongChapterSetEvidence(stems)).toBe(true);
    });

    it('AC2: dash separator "01 - Heir to the Empire" → true', () => {
      const stems = Array.from({ length: 5 }, (_, i) => ({
        path: `/lib/Book/${String(i + 1).padStart(2, '0')} - Heir to the Empire.mp3`,
        size: SHORT_STORY,
      }));
      expect(hasStrongChapterSetEvidence(stems)).toBe(true);
    });

    it('AC3: dot separator "01.Heir to the Empire" → true', () => {
      const stems = Array.from({ length: 5 }, (_, i) => ({
        path: `/lib/Book/${String(i + 1).padStart(2, '0')}.Heir to the Empire.mp3`,
        size: SHORT_STORY,
      }));
      expect(hasStrongChapterSetEvidence(stems)).toBe(true);
    });

    it('AC4: distinct title portions reject merge', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/01 Heir to the Empire.mp3', size: LARGE },
        { path: '/lib/Book/01 The Restaurant At The End Of The Universe.mp3', size: LARGE },
      ])).toBe(false);
    });

    it('AC5: mixed prefix participation rejects (one stem lacks the leading-numeric prefix)', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/01 Heir to the Empire.mp3', size: SHORT_STORY },
        { path: '/lib/Book/Heir to the Empire Bonus.mp3', size: SHORT_STORY },
        { path: '/lib/Book/02 Heir to the Empire.mp3', size: SHORT_STORY },
      ])).toBe(false);
    });

    it('AC6: numeric-only stems remain mergeable via the existing numeric-only rule', () => {
      // Empty post-prefix titles (e.g. "01", "02") are rejected by the new
      // rule's non-empty-title guard, so this case continues to merge through
      // the existing NUMERIC_ONLY_RE path regardless of rule evaluation order.
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/01.mp3', size: SHORT_STORY },
        { path: '/lib/Book/02.mp3', size: SHORT_STORY },
        { path: '/lib/Book/03.mp3', size: SHORT_STORY },
      ])).toBe(true);
    });

    it('AC13: bare digit-prefixed titles without separator boundary reject ("1Q84"/"2Q84")', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/1Q84.mp3', size: LARGE },
        { path: '/lib/Book/2Q84.mp3', size: LARGE },
      ])).toBe(false);
    });

    it('AC13: bare digit-prefixed titles without separator boundary reject ("01Heir"/"02Heir")', () => {
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Book/01Heir.mp3', size: LARGE },
        { path: '/lib/Book/02Heir.mp3', size: LARGE },
      ])).toBe(false);
    });

    it('AC10 (adversarial counter-test): "01 Book A"/"01 Book B"/"01 Book C" → false', () => {
      // Each is "track 1" of a different book, not chapters of one book.
      expect(hasStrongChapterSetEvidence([
        { path: '/lib/Pack/01 Book A.mp3', size: LARGE },
        { path: '/lib/Pack/01 Book B.mp3', size: LARGE },
        { path: '/lib/Pack/01 Book C.mp3', size: LARGE },
      ])).toBe(false);
    });

    it('AC9: trailing-digits "Heir to the Empire NN" → true (existing distinct===1 rule)', () => {
      // The existing normalizeStemForComparison strips trailing `\s+\d+\s*$`,
      // so all stems collapse to "Heir to the Empire" and merge through the
      // distinct === 1 rule. Pin the behavior so it doesn't regress.
      const stems = Array.from({ length: 5 }, (_, i) => ({
        path: `/lib/Book/Heir to the Empire ${String(i + 1).padStart(2, '0')}.mp3`,
        size: SHORT_STORY,
      }));
      expect(hasStrongChapterSetEvidence(stems)).toBe(true);
    });
  });
});
