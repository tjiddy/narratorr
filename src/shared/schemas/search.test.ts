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

  it('accepts replaceExisting: true', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      replaceExisting: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.replaceExisting).toBe(true);
  });

  it('accepts replaceExisting: false', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      replaceExisting: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.replaceExisting).toBe(false);
  });

  it('accepts omitted replaceExisting (optional field)', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.replaceExisting).toBeUndefined();
  });

  it('rejects non-boolean replaceExisting (e.g. string "true")', () => {
    const result = grabSchema.safeParse({
      downloadUrl: 'https://example.com',
      title: 'Test',
      replaceExisting: 'true',
    });
    expect(result.success).toBe(false);
  });
});
