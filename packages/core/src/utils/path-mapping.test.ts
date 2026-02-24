import { describe, it, expect } from 'vitest';
import { applyPathMapping, type PathMapping } from './path-mapping.js';

describe('applyPathMapping', () => {
  it('replaces remote prefix with local prefix when path matches', () => {
    const mappings: PathMapping[] = [
      { remotePath: '/downloads/complete/', localPath: 'C:\\downloads\\' },
    ];
    const result = applyPathMapping('/downloads/complete/BookTitle', mappings);
    expect(result).toBe('C:/downloads/BookTitle');
  });

  it('returns path unchanged when no mapping matches', () => {
    const mappings: PathMapping[] = [
      { remotePath: '/data/complete/', localPath: 'D:\\data\\' },
    ];
    const result = applyPathMapping('/downloads/complete/BookTitle', mappings);
    expect(result).toBe('/downloads/complete/BookTitle');
  });

  it('handles cross-platform separators (forward slash remote to backslash local)', () => {
    const mappings: PathMapping[] = [
      { remotePath: '/downloads/', localPath: 'C:\\downloads\\' },
    ];
    const result = applyPathMapping('/downloads/complete/BookTitle', mappings);
    expect(result).toBe('C:/downloads/complete/BookTitle');
  });

  it('handles cross-platform separators (backslash remote to forward slash local)', () => {
    const mappings: PathMapping[] = [
      { remotePath: 'C:\\downloads\\', localPath: '/mnt/downloads/' },
    ];
    const result = applyPathMapping('C:\\downloads\\complete\\BookTitle', mappings);
    expect(result).toBe('/mnt/downloads/complete/BookTitle');
  });

  it('selects longest matching remote prefix when multiple mappings match', () => {
    const mappings: PathMapping[] = [
      { remotePath: '/downloads/', localPath: '/mnt/data/' },
      { remotePath: '/downloads/complete/', localPath: '/mnt/finished/' },
    ];
    const result = applyPathMapping('/downloads/complete/BookTitle', mappings);
    expect(result).toBe('/mnt/finished/BookTitle');
  });

  it('normalizes trailing slashes before matching', () => {
    const mappings: PathMapping[] = [
      { remotePath: '/downloads/complete', localPath: 'C:\\downloads' },
    ];
    const result = applyPathMapping('/downloads/complete/BookTitle', mappings);
    expect(result).toBe('C:/downloads/BookTitle');
  });

  it('returns path unchanged when mappings array is empty', () => {
    const result = applyPathMapping('/downloads/complete/BookTitle', []);
    expect(result).toBe('/downloads/complete/BookTitle');
  });

  it('handles exact path match (path equals remote prefix)', () => {
    const mappings: PathMapping[] = [
      { remotePath: '/downloads/complete/BookTitle', localPath: 'C:\\downloads\\BookTitle' },
    ];
    const result = applyPathMapping('/downloads/complete/BookTitle', mappings);
    expect(result).toBe('C:/downloads/BookTitle');
  });
});
