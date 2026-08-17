import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PATH_SEGMENT_LIMIT } from '@core/utils/index.js';
import type { NamingOptions } from '@core/utils/naming.js';
import { useNamingPreviews } from './useNamingPreviews';

const DEFAULT_OPTIONS: NamingOptions = { separator: 'space', case: 'default' };
const PERIOD_LOWER: NamingOptions = { separator: 'period', case: 'lower' };

const FOLDER_STANDARD = '{author}/{title}';
const FILE_STANDARD = '{author} - {title}';
// Both track fixtures, so only the multi-file sample can produce them.
const FILE_MULTIFILE = '{title}{ - pt?trackNumber:00}{ of ?trackTotal}';

type Props = { folder: string | undefined; file: string | undefined; options: NamingOptions };

function setup(folder: string | undefined, file: string | undefined, options: NamingOptions = DEFAULT_OPTIONS) {
  return renderHook((p: Props) => useNamingPreviews(p.folder, p.file, p.options), {
    initialProps: { folder, file, options },
  });
}

describe('useNamingPreviews', () => {
  describe('folder and file previews', () => {
    it('renders the folder template against the with-series sample', () => {
      const { result } = setup(FOLDER_STANDARD, FILE_STANDARD);

      expect(result.current.folderPreview).toBe('Brandon Sanderson/The Way of Kings');
    });

    it('renders the no-series folder preview from its own fixture, not the with-series one', () => {
      const { result } = setup(FOLDER_STANDARD, FILE_STANDARD);

      expect(result.current.folderPreviewNoSeries).toBe('Andy Weir/Project Hail Mary');
      expect(result.current.folderPreviewNoSeries).not.toBe(result.current.folderPreview);
    });

    it('renders both file previews from their matching fixtures', () => {
      const { result } = setup(FOLDER_STANDARD, FILE_STANDARD);

      expect(result.current.filePreview).toBe('Brandon Sanderson - The Way of Kings');
      expect(result.current.filePreviewNoSeries).toBe('Andy Weir - Project Hail Mary');
    });

    it('renders the multi-file preview from the track fixtures the other file previews lack', () => {
      const { result } = setup(FOLDER_STANDARD, FILE_MULTIFILE);

      expect(result.current.filePreviewMultiFile).toBe('The Way of Kings - pt03 of 12');
      expect(result.current.filePreview).toBe('The Way of Kings');
    });

    it('keeps a path separator in the folder preview but folds it into one filename segment', () => {
      const { result } = setup('{author}/{title}', '{author}/{title}');

      expect(result.current.folderPreview).toBe('Brandon Sanderson/The Way of Kings');
      expect(result.current.filePreview).toBe('Brandon SandersonThe Way of Kings');
    });
  });

  describe('folderPreviewMultiEdition', () => {
    it('renders an explicit terminal {edition} in place without also appending a suffix', () => {
      const { result } = setup('{author}/{title} ({edition})', undefined);

      expect(result.current.folderPreviewMultiEdition).toBe('Brandon Sanderson/The Way of Kings (Full Cast)');
      expect(result.current.folderPreviewMultiEdition.match(/Full Cast/g)).toHaveLength(1);
    });

    it('leaves an explicit non-terminal {edition} in its own segment', () => {
      const { result } = setup('{author} ({edition})/{title}', undefined);

      expect(result.current.folderPreviewMultiEdition).toBe('Brandon Sanderson (Full Cast)/The Way of Kings');
    });

    it('auto-suffixes only the final segment when the template has no {edition}', () => {
      const { result } = setup(FOLDER_STANDARD, undefined);

      expect(result.current.folderPreviewMultiEdition).toBe('Brandon Sanderson/The Way of Kings (Full Cast)');
    });

    it('auto-suffixes the sole segment of a single-segment path', () => {
      const { result } = setup('{title}', undefined);

      expect(result.current.folderPreviewMultiEdition).toBe('The Way of Kings (Full Cast)');
    });

    it('budgets an over-long leaf down to the path-segment limit and still ends in the edition', () => {
      const { result } = setup(`{author}/{title} ${'A'.repeat(300)}`, undefined);

      const leaf = result.current.folderPreviewMultiEdition.split('/')[1]!;
      expect(leaf).toHaveLength(PATH_SEGMENT_LIMIT);
      expect(leaf.endsWith(' (Full Cast)')).toBe(true);
    });

    it('suffixes an empty rendered leaf, producing the leading-space form', () => {
      // {partName} has no value in the folder sample, so the template renders to nothing.
      const { result } = setup('{partName}', undefined);

      expect(result.current.folderPreview).toBe('');
      expect(result.current.folderPreviewMultiEdition).toBe(' (Full Cast)');
    });
  });

  describe('filePreviewEdition', () => {
    it('reports no token and an empty render when the file format omits {edition}', () => {
      const { result } = setup(undefined, FILE_STANDARD);

      expect(result.current.filePreviewEdition).toEqual({ hasToken: false, rendered: '' });
    });

    it('renders the edition in place when the file format contains {edition}', () => {
      const { result } = setup(undefined, '{author} - {title} ({edition})');

      expect(result.current.filePreviewEdition).toEqual({
        hasToken: true,
        rendered: 'Brandon Sanderson - The Way of Kings (Full Cast)',
      });
    });

    it('never auto-appends the edition to a file, even where the folder preview does', () => {
      const { result } = setup(FOLDER_STANDARD, FILE_STANDARD);

      expect(result.current.filePreviewEdition).toEqual({ hasToken: false, rendered: '' });
      expect(result.current.folderPreviewMultiEdition).toBe('Brandon Sanderson/The Way of Kings (Full Cast)');
    });
  });

  describe('falsy and missing formats', () => {
    it('returns empty previews for two empty-string formats', () => {
      const { result } = setup('', '');

      expect(result.current).toEqual({
        folderPreview: '',
        folderPreviewNoSeries: '',
        folderPreviewMultiEdition: '',
        filePreview: '',
        filePreviewNoSeries: '',
        filePreviewMultiFile: '',
        filePreviewEdition: { hasToken: false, rendered: '' },
      });
    });

    it('returns empty previews for two undefined formats without throwing', () => {
      const { result } = setup(undefined, undefined);

      expect(result.current).toEqual({
        folderPreview: '',
        folderPreviewNoSeries: '',
        folderPreviewMultiEdition: '',
        filePreview: '',
        filePreviewNoSeries: '',
        filePreviewMultiFile: '',
        filePreviewEdition: { hasToken: false, rendered: '' },
      });
    });

    it('renders the folder side while the file side stays empty', () => {
      const { result } = setup(FOLDER_STANDARD, '');

      expect(result.current.folderPreview).toBe('Brandon Sanderson/The Way of Kings');
      expect(result.current.folderPreviewNoSeries).toBe('Andy Weir/Project Hail Mary');
      expect(result.current.folderPreviewMultiEdition).toBe('Brandon Sanderson/The Way of Kings (Full Cast)');
      expect(result.current.filePreview).toBe('');
      expect(result.current.filePreviewNoSeries).toBe('');
      expect(result.current.filePreviewMultiFile).toBe('');
    });
  });

  describe('naming options', () => {
    it('recomputes every preview when the options change between renders', () => {
      const { result, rerender } = setup(FOLDER_STANDARD, FILE_MULTIFILE);

      rerender({ folder: FOLDER_STANDARD, file: FILE_MULTIFILE, options: PERIOD_LOWER });

      expect(result.current.folderPreview).toBe('brandon.sanderson/the.way.of.kings');
      expect(result.current.folderPreviewNoSeries).toBe('andy.weir/project.hail.mary');
      expect(result.current.folderPreviewMultiEdition).toBe('brandon.sanderson/the.way.of.kings (Full Cast)');
      expect(result.current.filePreview).toBe('the.way.of.kings');
      expect(result.current.filePreviewNoSeries).toBe('project.hail.mary');
      expect(result.current.filePreviewMultiFile).toBe('the.way.of.kings - pt03 of 12');
      expect(result.current.filePreviewEdition).toEqual({ hasToken: false, rendered: '' });
    });

    it('leaves the folder edition label unstyled while styling the file edition', () => {
      const { result } = setup(FOLDER_STANDARD, '{author} - {title} ({edition})', PERIOD_LOWER);

      expect(result.current.folderPreviewMultiEdition).toBe('brandon.sanderson/the.way.of.kings (Full Cast)');
      expect(result.current.filePreviewEdition.rendered).toBe('brandon.sanderson - the.way.of.kings (full.cast)');
    });
  });

  describe('memoization', () => {
    it('keeps the edition pair referentially stable across a rerender with the same inputs', () => {
      const options = DEFAULT_OPTIONS;
      const { result, rerender } = setup(FOLDER_STANDARD, FILE_STANDARD, options);
      const first = result.current.filePreviewEdition;

      rerender({ folder: FOLDER_STANDARD, file: FILE_STANDARD, options });

      expect(result.current.filePreviewEdition).toBe(first);
    });

    it('returns a new edition pair when the options object is a new reference of equal value', () => {
      const { result, rerender } = setup(FOLDER_STANDARD, FILE_STANDARD);
      const first = result.current.filePreviewEdition;

      rerender({ folder: FOLDER_STANDARD, file: FILE_STANDARD, options: { separator: 'space', case: 'default' } });

      expect(result.current.filePreviewEdition).not.toBe(first);
      expect(result.current.filePreviewEdition).toEqual(first);
    });
  });
});
