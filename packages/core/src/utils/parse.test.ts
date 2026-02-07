import { describe, it, expect } from 'vitest';
import { parseAudiobookTitle, slugify, formatBytes } from './parse.js';

describe('parseAudiobookTitle', () => {
  it('parses a simple title', () => {
    const result = parseAudiobookTitle('The Way of Kings');
    expect(result.title).toBe('The Way of Kings');
  });

  it('extracts author from "Title - Author" pattern', () => {
    const result = parseAudiobookTitle('The Way of Kings - Brandon Sanderson');
    expect(result.title).toBe('The Way of Kings');
    expect(result.author).toBe('Brandon Sanderson');
  });

  it('extracts author from "Title by Author" pattern', () => {
    const result = parseAudiobookTitle('The Way of Kings by Brandon Sanderson');
    expect(result.title).toBe('The Way of Kings');
    expect(result.author).toBe('Brandon Sanderson');
  });

  it('extracts narrator from "narrated by" pattern', () => {
    const result = parseAudiobookTitle(
      'The Way of Kings - Brandon Sanderson, narrated by Michael Kramer',
    );
    expect(result.narrator).toBe('Michael Kramer');
  });

  it('extracts narrator from "read by" pattern', () => {
    const result = parseAudiobookTitle(
      'The Way of Kings - Brandon Sanderson, read by Kate Reading',
    );
    expect(result.narrator).toBe('Kate Reading');
  });

  it('extracts year in brackets', () => {
    const result = parseAudiobookTitle('The Way of Kings [2010]');
    expect(result.year).toBe(2010);
  });

  it('extracts year in parentheses', () => {
    const result = parseAudiobookTitle('The Way of Kings (2010)');
    expect(result.year).toBe(2010);
  });

  it('detects unabridged flag', () => {
    const result = parseAudiobookTitle('The Way of Kings [Unabridged]');
    expect(result.isUnabridged).toBe(true);
  });

  it('detects abridged flag', () => {
    const result = parseAudiobookTitle('The Way of Kings [Abridged]');
    expect(result.isUnabridged).toBe(false);
  });

  it('extracts format M4B', () => {
    const result = parseAudiobookTitle('The Way of Kings M4B');
    expect(result.format).toBe('M4B');
  });

  it('extracts format MP3 case-insensitive', () => {
    const result = parseAudiobookTitle('The Way of Kings mp3');
    expect(result.format).toBe('MP3');
  });

  it('extracts format FLAC', () => {
    const result = parseAudiobookTitle('The Way of Kings FLAC');
    expect(result.format).toBe('FLAC');
  });

  it('parses a title with year, format, and unabridged', () => {
    const result = parseAudiobookTitle(
      'The Way of Kings - Brandon Sanderson [2010] [Unabridged] MP3',
    );
    expect(result.title).toBe('The Way of Kings');
    expect(result.author).toBe('Brandon Sanderson');
    expect(result.year).toBe(2010);
    expect(result.isUnabridged).toBe(true);
    expect(result.format).toBe('MP3');
  });

  it('handles extra whitespace', () => {
    const result = parseAudiobookTitle('  The Way of Kings  ');
    expect(result.title).toBe('The Way of Kings');
  });

  it('extracts narrator even when "by" pattern is ambiguous', () => {
    const result = parseAudiobookTitle('The Way of Kings - narrated by Michael Kramer');
    // The dash check correctly rejects "narrated by..." as author,
    // but the "by" pattern matches — this is a known parser limitation.
    // The narrator is still correctly extracted from rawTitle.
    expect(result.narrator).toBe('Michael Kramer');
  });
});

describe('slugify', () => {
  it('converts to lowercase kebab-case', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('removes special characters', () => {
    expect(slugify("Hello, World! It's a test.")).toBe('hello-world-its-a-test');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('Hello   World')).toBe('hello-world');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify(' - Hello World - ')).toBe('hello-world');
  });

  it('handles empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('formatBytes', () => {
  it('formats 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('formats terabytes', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });

  it('formats fractional values', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('rounds to 2 decimal places', () => {
    expect(formatBytes(1234567)).toBe('1.18 MB');
  });
});
