import { describe, expect, it } from 'vitest';
import { createBlacklistSchema } from './blacklist.js';

const validBase = {
  infoHash: 'abc123',
  title: 'Some Title',
  reason: 'bad_quality' as const,
};

describe('createBlacklistSchema — trim behavior', () => {
  it('rejects whitespace-only infoHash', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, infoHash: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only title', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, title: '   ' });
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from infoHash', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, infoHash: '  abc123  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.infoHash).toBe('abc123');
  });

  it('trims leading/trailing spaces from title', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, title: '  Some Title  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.title).toBe('Some Title');
  });

  it('accepts valid infoHash and title without trim errors', () => {
    const result = createBlacklistSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });
});
