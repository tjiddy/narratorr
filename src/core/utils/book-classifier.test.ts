import { describe, it, expect } from 'vitest';
import { classifyLeafFolder, type ClassifierFile } from './book-classifier.js';
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

    it('marker guard fires BEFORE size guard when a chapter file is among small files', () => {
      // 3 small (50 MB) files; one has a chapter marker. The size guard would
      // also fire, but marker takes precedence per the documented order.
      const result = classifyLeafFolder([
        { path: '/lib/Book/Chapter 01.mp3', size: SHORT_STORY },
        { path: '/lib/Book/Other Two.mp3', size: SHORT_STORY },
        { path: '/lib/Book/Other Three.mp3', size: SHORT_STORY },
      ]);
      expect(result).toEqual({ decision: 'merge', reason: 'chapter-disc-part-marker' });
    });

    it('count-cap fires before any other check', () => {
      // 31 chapter-marker files — would also fire chapter guard, but cap wins.
      const paths = Array.from({ length: 31 }, (_, i) => `/lib/Book/Chapter ${i + 1}.mp3`);
      const result = classifyLeafFolder(paths.map(p => ({ path: p, size: SMALL })));
      expect(result).toEqual({ decision: 'merge', reason: 'count-exceeds-cap' });
    });
  });
});
