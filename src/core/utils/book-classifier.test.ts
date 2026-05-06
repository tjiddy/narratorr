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
      expect(result).toEqual({ decision: 'split', reason: 'distinct-large-files-no-marker' });
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
      expect(result).toEqual({ decision: 'split', reason: 'distinct-large-files-no-marker' });
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
      expect(result).toEqual({ decision: 'split', reason: 'distinct-large-files-no-marker' });
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
      expect(result).toEqual({ decision: 'split', reason: 'distinct-large-files-no-marker' });
    });

    it('60% large files trips size guard', () => {
      const result = classifyLeafFolder(files([
        { path: '/lib/Pack/StoryAlpha.mp3', size: LARGE },
        { path: '/lib/Pack/StoryBeta.mp3', size: LARGE },
        { path: '/lib/Pack/StoryGamma.mp3', size: LARGE },
        { path: '/lib/Pack/StoryDelta.mp3', size: SHORT_STORY },
        { path: '/lib/Pack/StoryEpsilon.mp3', size: SHORT_STORY },
      ]));
      expect(result.reason).toBe('files-too-small-for-full-books');
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
