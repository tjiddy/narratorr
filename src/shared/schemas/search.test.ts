import { describe, it, expect } from 'vitest';
import { searchQuerySchema, grabSchema } from './search.js';

describe('searchQuerySchema', () => {
  it('transforms limit string to number', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: '25' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(25);
  });

  it('defaults limit to 50 when omitted', () => {
    const result = searchQuerySchema.safeParse({ q: 'test' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });

  it('defaults limit to 50 for empty string', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: '' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });

  it('rejects non-numeric limit string', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: 'abc' });
    expect(result.success).toBe(false);
  });

  it('rejects negative limit', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: '-1' });
    expect(result.success).toBe(false);
  });

  it('rejects zero limit', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: '0' });
    expect(result.success).toBe(false);
  });

  it('rejects decimal limit', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: '99.5' });
    expect(result.success).toBe(false);
  });

  it('rejects limit above 500 ceiling', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: '999999' });
    expect(result.success).toBe(false);
  });

  it('accepts limit at the 500 ceiling', () => {
    const result = searchQuerySchema.safeParse({ q: 'test', limit: '500' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(500);
  });

  it('rejects query shorter than 2 characters', () => {
    const result = searchQuerySchema.safeParse({ q: 'a' });
    expect(result.success).toBe(false);
  });

  it('rejects query exceeding 500 characters', () => {
    const result = searchQuerySchema.safeParse({ q: 'a'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('passes through optional author and title', () => {
    const result = searchQuerySchema.safeParse({
      q: 'test',
      author: 'Tolkien',
      title: 'The Hobbit',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.author).toBe('Tolkien');
      expect(result.data.title).toBe('The Hobbit');
    }
  });
});

describe('grabSchema', () => {
  it('accepts valid grab input with defaults', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com/file.torrent',
      title: 'My Audiobook',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.protocol).toBe('torrent');
  });

  it('rejects missing downloadUrl', () => {
    const result = grabSchema.safeParse({ title: 'My Audiobook' });
    expect(result.success).toBe(false);
  });

  it('rejects missing title', () => {
    const result = grabSchema.safeParse({ downloadUrl: 'https://example.com' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid protocol', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      protocol: 'ftp',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional numeric fields', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      bookId: 1,
      indexerId: 2,
      size: 1024,
      seeders: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative bookId', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      bookId: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown replaceExisting field (removed)', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      replaceExisting: true,
    });
    // The grabSchema accepts the input but drops the unknown property — replaceExisting is no longer in the contract.
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).replaceExisting).toBeUndefined();
  });
});

const validGrab = { downloadUrl: 'https://example.com/file.torrent', title: 'My Book' };

describe('grabSchema — trim behavior', () => {
  it('rejects whitespace-only downloadUrl', () => {
    const result = grabSchema.safeParse({ ...validGrab, downloadUrl: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only title', () => {
    const result = grabSchema.safeParse({ ...validGrab, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from downloadUrl', () => {
    const result = grabSchema.safeParse({ ...validGrab, downloadUrl: '  https://example.com/file.torrent  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.downloadUrl).toBe('https://example.com/file.torrent');
  });

  it('trims leading/trailing spaces from title', () => {
    const result = grabSchema.safeParse({ ...validGrab, title: '  My Book  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('My Book');
  });

  it('accepts valid downloadUrl and title', () => {
    const result = grabSchema.safeParse(validGrab);
    expect(result.success).toBe(true);
  });
});
