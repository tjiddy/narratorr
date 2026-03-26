import { describe, expect, it } from 'vitest';
import {
  importConfirmItemSchema,
  jobIdParamSchema,
  matchCandidateSchema,
  scanDirectoryBodySchema,
  scanSingleBodySchema,
} from './library-scan.js';

describe('scanSingleBodySchema — trim behavior', () => {
  it('rejects whitespace-only path', () => {
    const result = scanSingleBodySchema.safeParse({ path: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from path', () => {
    const result = scanSingleBodySchema.safeParse({ path: '  /books/file.mp3  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('/books/file.mp3');
  });
});

describe('scanDirectoryBodySchema — trim behavior', () => {
  it('rejects whitespace-only path', () => {
    const result = scanDirectoryBodySchema.safeParse({ path: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from path', () => {
    const result = scanDirectoryBodySchema.safeParse({ path: '  /books/  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('/books/');
  });
});

describe('importConfirmItemSchema — trim behavior', () => {
  const validItem = { path: '/books/file.mp3', title: 'My Book' };

  it('rejects whitespace-only path', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, path: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only title', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from path', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, path: '  /books/file.mp3  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.path).toBe('/books/file.mp3');
  });

  it('trims leading/trailing spaces from title', () => {
    const result = importConfirmItemSchema.safeParse({ ...validItem, title: '  My Book  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('My Book');
  });

  it('accepts valid path and title', () => {
    const result = importConfirmItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
  });
});

describe('matchCandidateSchema — trim behavior', () => {
  const validCandidate = { path: '/books/file.mp3', title: 'My Book' };

  it('rejects whitespace-only path', () => {
    const result = matchCandidateSchema.safeParse({ ...validCandidate, path: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only title', () => {
    const result = matchCandidateSchema.safeParse({ ...validCandidate, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from path and title', () => {
    const result = matchCandidateSchema.safeParse({
      path: '  /books/file.mp3  ',
      title: '  My Book  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.path).toBe('/books/file.mp3');
      expect(result.data.title).toBe('My Book');
    }
  });
});

describe('jobIdParamSchema — trim behavior', () => {
  it('rejects whitespace-only jobId', () => {
    const result = jobIdParamSchema.safeParse({ jobId: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from jobId', () => {
    const result = jobIdParamSchema.safeParse({ jobId: '  job-123  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.jobId).toBe('job-123');
  });
});
