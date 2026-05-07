import { describe, it, expect } from 'vitest';
import { planTagSearchAttempts, MAX_TAG_SEARCH_ATTEMPTS } from './tag-search-planner.js';
import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import type { TagQuery } from './match-job.helpers.js';

function makeScan(overrides: Partial<AudioScanResult> = {}): AudioScanResult {
  return {
    codec: 'AAC',
    bitrate: 128000,
    sampleRate: 44100,
    channels: 2,
    bitrateMode: 'cbr',
    fileFormat: 'm4b',
    totalDuration: 36000,
    totalSize: 100_000_000,
    fileCount: 1,
    hasCoverArt: false,
    ...overrides,
  };
}

const author = 'Test Author';

describe('planTagSearchAttempts', () => {
  it('emits exact attempt as the first entry (high cap)', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: 'Some Book', author });
    expect(attempts[0]).toEqual({ title: 'Some Book', author, source: 'exact', maxConfidence: 'high' });
  });

  it('emits album attempt with medium cap when tagAlbum produces a candidate', () => {
    const scan = makeScan({ tagAlbum: 'The Dark Forest (Unabridged)' });
    const attempts = planTagSearchAttempts(scan, { title: 'The Dark Forest: The Three-Body Problem, Book 2', author });
    const albumAttempt = attempts.find(a => a.source === 'album');
    expect(albumAttempt).toBeDefined();
    expect(albumAttempt!.title).toBe('The Dark Forest');
    expect(albumAttempt!.maxConfidence).toBe('medium');
  });

  it('AC11 — multi-file album with `- Series, Book N` cleans to bare title (Imagine Me)', () => {
    const scan = makeScan({ tagAlbum: 'Imagine Me - Shatter Me Series, Book 6' });
    const attempts = planTagSearchAttempts(scan, { title: 'Imagine Me - Part 3', author });
    const albumAttempt = attempts.find(a => a.source === 'album');
    expect(albumAttempt).toBeDefined();
    expect(albumAttempt!.title).toBe('Imagine Me');
  });

  it('AC11 — preserves edition annotations like `Special Edition, Book 1` (no series keyword)', () => {
    // `- Special Edition, Book 1` does NOT match the dash-series-keyword regex
    // (no "series/saga/trilogy/cycle/chronicles"); cleanTagTitle then strips
    // `, Book 1` only, leaving `The Hobbit - Special Edition`.
    const scan = makeScan({ tagAlbum: 'The Hobbit - Special Edition, Book 1' });
    const attempts = planTagSearchAttempts(scan, { title: 'The Hobbit', author });
    const albumAttempt = attempts.find(a => a.source === 'album');
    expect(albumAttempt?.title).toBe('The Hobbit - Special Edition');
  });

  it('emits strip-trailing-part when title ends in `- Part N`', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: 'Imagine Me - Part 3', author });
    const stripped = attempts.find(a => a.source === 'strip-trailing-part');
    expect(stripped).toBeDefined();
    expect(stripped!.title).toBe('Imagine Me');
    expect(stripped!.maxConfidence).toBe('medium');
  });

  it('AC9 — strip-leading-series with apostrophe and hyphen prefix preserves single-quote', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: "Mary-Lou's 1 - Adventure Time", author });
    const stripped = attempts.find(a => a.source === 'strip-leading-series');
    expect(stripped).toBeDefined();
    expect(stripped!.title).toBe('Adventure Time');
  });

  it('AC9 — strip-leading-series supports en-dash separator', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: 'Reacher 00.15 – Second Son', author });
    const stripped = attempts.find(a => a.source === 'strip-leading-series');
    expect(stripped).toBeDefined();
    expect(stripped!.title).toBe('Second Son');
  });

  it('AC9 — strip-leading-series supports em-dash and decimal positions', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: 'Reacher 00.15—Second Son', author });
    const stripped = attempts.find(a => a.source === 'strip-leading-series');
    expect(stripped?.title).toBe('Second Son');
  });

  it('AC10 — strip-colon-suffix fires when colon position > 0 and suffix ≥ 3 chars', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: 'The Dark Forest: The Three-Body Problem, Book 2', author });
    const stripped = attempts.find(a => a.source === 'strip-colon-suffix');
    expect(stripped?.title).toBe('The Dark Forest');
    expect(stripped?.maxConfidence).toBe('medium');
  });

  it('AC10 — strip-colon-suffix does NOT fire when prefix < 3 chars', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: 'AB: Long Subtitle Here', author });
    expect(attempts.find(a => a.source === 'strip-colon-suffix')).toBeUndefined();
  });

  it('AC10 — strip-colon-suffix does NOT fire when colon is at position 0', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: ':Title with leading colon', author });
    expect(attempts.find(a => a.source === 'strip-colon-suffix')).toBeUndefined();
  });

  it('AC27 — deduplicates identical titles (case- and whitespace-insensitive)', () => {
    // tagAlbum equals tagQuery title → only one attempt emitted.
    const scan = makeScan({ tagAlbum: 'imagine me' });
    const attempts = planTagSearchAttempts(scan, { title: 'Imagine Me', author });
    const titles = attempts.map(a => a.title.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('AC28 — caps attempts at MAX_TAG_SEARCH_ATTEMPTS', () => {
    // Construct an input that triggers every possible attempt.
    const scan = makeScan({ tagAlbum: 'Distinct Album Title' });
    const attempts = planTagSearchAttempts(scan, {
      title: 'Series Name 1.5 - Some Title: Subtitle - Part 2',
      author,
    });
    expect(attempts.length).toBeLessThanOrEqual(MAX_TAG_SEARCH_ATTEMPTS);
  });

  it('AC8 — album attempt requires cleaned candidate ≥ 3 chars', () => {
    const scan = makeScan({ tagAlbum: 'AB' });
    const attempts = planTagSearchAttempts(scan, { title: 'Some Book', author });
    expect(attempts.find(a => a.source === 'album')).toBeUndefined();
  });

  it('regression: 11-22-63 (numeric title) emits only the exact attempt', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: '11-22-63', author });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.source).toBe('exact');
  });

  it('regression: Mistborn: The Final Empire — strip-colon-suffix is NOT pre-applied (exact still leads)', () => {
    const scan = makeScan();
    const attempts = planTagSearchAttempts(scan, { title: 'Mistborn: The Final Empire', author });
    expect(attempts[0]!.source).toBe('exact');
    expect(attempts[0]!.title).toBe('Mistborn: The Final Empire');
    // strip-colon-suffix attempt also exists but follows exact; AC24's "no retries fire"
    // is enforced by runTagSearch terminating on the first successful attempt.
    expect(attempts.find(a => a.source === 'strip-colon-suffix')?.title).toBe('Mistborn');
  });
});
