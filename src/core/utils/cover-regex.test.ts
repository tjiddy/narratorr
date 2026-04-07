import { describe, expect, it } from 'vitest';
import { COVER_FILE_REGEX } from './cover-regex.js';

describe('COVER_FILE_REGEX', () => {
  it('matches all supported cover extensions', () => {
    expect('cover.jpg').toMatch(COVER_FILE_REGEX);
    expect('cover.jpeg').toMatch(COVER_FILE_REGEX);
    expect('cover.png').toMatch(COVER_FILE_REGEX);
    expect('cover.webp').toMatch(COVER_FILE_REGEX);
  });

  it('matches case-insensitively', () => {
    expect('Cover.JPG').toMatch(COVER_FILE_REGEX);
    expect('COVER.PNG').toMatch(COVER_FILE_REGEX);
    expect('cover.Webp').toMatch(COVER_FILE_REGEX);
  });

  it('rejects non-cover filenames', () => {
    expect('artwork.jpg').not.toMatch(COVER_FILE_REGEX);
    expect('coverart.jpg').not.toMatch(COVER_FILE_REGEX);
    expect('cover.jpg.bak').not.toMatch(COVER_FILE_REGEX);
    expect('folder.jpg').not.toMatch(COVER_FILE_REGEX);
    expect('mycover.jpg').not.toMatch(COVER_FILE_REGEX);
  });

  it('rejects unsupported extensions', () => {
    expect('cover.bmp').not.toMatch(COVER_FILE_REGEX);
    expect('cover.tiff').not.toMatch(COVER_FILE_REGEX);
    expect('cover.gif').not.toMatch(COVER_FILE_REGEX);
    expect('cover.svg').not.toMatch(COVER_FILE_REGEX);
  });
});
