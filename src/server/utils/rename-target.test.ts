import { describe, it, expect } from 'vitest';
import { computeFolderTarget, toLibraryRelative, type FolderTargetRow } from './rename-target.js';

const LIBRARY = { path: '/library', folderFormat: '{author}/{title}' };
const OPTS = {};

function row(overrides: Partial<FolderTargetRow> & { path: string; title: string }): FolderTargetRow {
  return { seriesName: null, seriesPosition: null, publishedDate: null, narrators: [], ...overrides };
}

describe('computeFolderTarget', () => {
  it('reports changed:false when the current path already matches the template', () => {
    const result = computeFolderTarget(
      row({ path: '/library/Brandon Sanderson/The Way of Kings', title: 'The Way of Kings' }),
      'Brandon Sanderson',
      LIBRARY,
      OPTS,
    );
    expect(result.changed).toBe(false);
    expect(result.targetPath).toBe('/library/Brandon Sanderson/The Way of Kings');
  });

  it('reports changed:true and the new target when the folder differs', () => {
    const result = computeFolderTarget(
      row({ path: '/library/Brandon Sanderson/OldName', title: 'The Way of Kings' }),
      'Brandon Sanderson',
      LIBRARY,
      OPTS,
    );
    expect(result.changed).toBe(true);
    expect(result.targetPath).toBe('/library/Brandon Sanderson/The Way of Kings');
  });

  it('normalizes backslash-stored paths before comparing (Windows imports match)', () => {
    const result = computeFolderTarget(
      row({ path: '/library/Brandon Sanderson/The Way of Kings'.split('/').join('\\'), title: 'The Way of Kings' }),
      'Brandon Sanderson',
      LIBRARY,
      OPTS,
    );
    expect(result.changed).toBe(false);
  });

  it('renders {narrator} / {narratorLastFirst} from ordered narrators (primary first)', () => {
    const narratorLibrary = { path: '/library', folderFormat: '{narrator}/{title}' };
    const result = computeFolderTarget(
      row({
        path: '/library/whatever',
        title: 'The Way of Kings',
        narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
      }),
      'Brandon Sanderson',
      narratorLibrary,
      OPTS,
    );
    // Primary narrator (first in the ordered list) drives the {narrator} token.
    expect(result.targetPath).toBe('/library/Michael Kramer/The Way of Kings');

    const lastFirst = computeFolderTarget(
      row({
        path: '/library/whatever',
        title: 'The Way of Kings',
        narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
      }),
      'Brandon Sanderson',
      { path: '/library', folderFormat: '{narratorLastFirst}/{title}' },
      OPTS,
    );
    expect(lastFirst.targetPath).toBe('/library/Kramer, Michael/The Way of Kings');
  });

  describe('{edition} suppression/append rule mirrors buildTargetPath (#1712)', () => {
    it('template lacking {edition}: appends the mandatory " (label)" suffix from row.editionLabel', () => {
      const result = computeFolderTarget(
        row({ path: '/library/whatever', title: 'Dark Matter', editionLabel: 'Full Cast' }),
        'Blake Crouch',
        LIBRARY,
        OPTS,
      );
      expect(result.targetPath).toBe('/library/Blake Crouch/Dark Matter (Full Cast)');
    });

    it('template containing {edition}: renders the label once, no doubled suffix', () => {
      const result = computeFolderTarget(
        row({ path: '/library/whatever', title: 'Dark Matter', editionLabel: 'Full Cast' }),
        'Blake Crouch',
        { path: '/library', folderFormat: '{author}/{title} ({edition})' },
        OPTS,
      );
      expect(result.targetPath).toBe('/library/Blake Crouch/Dark Matter (Full Cast)');
      expect(result.targetPath.match(/Full Cast/g)).toHaveLength(1);
    });

    it('null editionLabel: no label emitted (single-edition books never re-pathed)', () => {
      const result = computeFolderTarget(
        row({ path: '/library/Blake Crouch/Dark Matter', title: 'Dark Matter', editionLabel: null }),
        'Blake Crouch',
        LIBRARY,
        OPTS,
      );
      expect(result.changed).toBe(false);
      expect(result.targetPath).toBe('/library/Blake Crouch/Dark Matter');
    });
  });
});

describe('toLibraryRelative', () => {
  it('returns a library-relative POSIX path for paths inside the root', () => {
    expect(toLibraryRelative('/library/Author/Title', '/library')).toBe('Author/Title');
  });

  it('falls back to the original absolute path when the path is outside the root', () => {
    expect(toLibraryRelative('/elsewhere/Author/Title', '/library')).toBe('/elsewhere/Author/Title');
  });
});
