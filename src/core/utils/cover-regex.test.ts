import { describe, it } from 'vitest';

describe('COVER_FILE_REGEX', () => {
  it.todo('matches cover.jpg, cover.jpeg, cover.png, cover.webp');
  it.todo('matches case-insensitively (Cover.JPG, COVER.PNG)');
  it.todo('rejects non-cover filenames (artwork.jpg, coverart.jpg, cover.gif, cover.jpg.bak, folder.jpg)');
  it.todo('rejects cover with unsupported extension (cover.bmp, cover.tiff)');
});
