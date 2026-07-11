import { describe, it, expect } from 'vitest';
import { searchQuerySchema, grabSchema, grabBodySchema } from './search.js';

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

  it('rejects unknown replaceExisting field (#1103: schema is .strict())', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      replaceExisting: true,
    });
    // .strict() rejects unknown keys with a Zod issue rather than silently stripping them.
    expect(result.success).toBe(false);
  });

  it('accepts optional isFreeleech (#1156)', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      isFreeleech: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isFreeleech).toBe(true);
  });

  it('omits isFreeleech from output when not provided (#1156)', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.isFreeleech).toBeUndefined();
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

describe('grabSchema — replace + infoHash (#1857)', () => {
  it('defaults replace to false when omitted', () => {
    const result = grabSchema.safeParse(validGrab);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.replace).toBe(false);
  });

  it('accepts replace: true', () => {
    const result = grabSchema.safeParse({ ...validGrab, bookId: 1, replace: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.replace).toBe(true);
  });

  it('rejects non-boolean replace', () => {
    const result = grabSchema.safeParse({ ...validGrab, replace: 'yes' });
    expect(result.success).toBe(false);
  });

  it('accepts optional infoHash', () => {
    const result = grabSchema.safeParse({ ...validGrab, infoHash: 'abc123' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.infoHash).toBe('abc123');
  });

  it('omits infoHash from output when not provided', () => {
    const result = grabSchema.safeParse(validGrab);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.infoHash).toBeUndefined();
  });

  it('still rejects the legacy replaceExisting key even alongside replace', () => {
    const result = grabSchema.safeParse({ ...validGrab, replace: true, replaceExisting: true });
    expect(result.success).toBe(false);
  });

  it('exposes .shape (base object schema, not a ZodEffects) for the client picker', () => {
    // The client's pickGrabFields reads grabSchema.shape — guard that .shape survives.
    expect(Object.keys(grabSchema.shape)).toContain('replace');
    expect(Object.keys(grabSchema.shape)).toContain('infoHash');
  });
});

describe('grabBodySchema — replace requires bookId (#1857)', () => {
  it('accepts replace: true with a bookId', () => {
    const result = grabBodySchema.safeParse({ ...validGrab, bookId: 7, replace: true });
    expect(result.success).toBe(true);
  });

  it('rejects replace: true without a bookId (→ 400)', () => {
    const result = grabBodySchema.safeParse({ ...validGrab, replace: true });
    expect(result.success).toBe(false);
  });

  it('accepts replace omitted without a bookId (ordinary orphan grab)', () => {
    const result = grabBodySchema.safeParse(validGrab);
    expect(result.success).toBe(true);
  });

  it('still rejects replaceExisting through the refined body schema', () => {
    const result = grabBodySchema.safeParse({ ...validGrab, replaceExisting: true });
    expect(result.success).toBe(false);
  });
});
