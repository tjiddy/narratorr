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

  // ===== #248 — GUID + optional infoHash =====

  it('accepts guid only (no infoHash)', () => {
    const { infoHash: _, ...base } = validBase;
    const result = createBlacklistSchema.safeParse({ ...base, guid: 'some-guid-value' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.guid).toBe('some-guid-value');
  });

  it('accepts infoHash only (no guid) — backward compatible', () => {
    const result = createBlacklistSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.infoHash).toBe('abc123');
  });

  it('accepts both infoHash and guid', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, guid: 'some-guid-value' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.infoHash).toBe('abc123');
      expect(result.data.guid).toBe('some-guid-value');
    }
  });

  it('rejects when neither infoHash nor guid is provided', () => {
    const { infoHash: _, ...base } = validBase;
    const result = createBlacklistSchema.safeParse(base);
    expect(result.success).toBe(false);
  });

  it('trims leading/trailing spaces from guid', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, guid: '  some-guid  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.guid).toBe('some-guid');
  });

  it('rejects whitespace-only guid', () => {
    const { infoHash: _, ...base } = validBase;
    const result = createBlacklistSchema.safeParse({ ...base, guid: '   ' });
    expect(result.success).toBe(false);
  });

  // #315 — user_cancelled reason
  it('accepts user_cancelled as a valid blacklist reason', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, reason: 'user_cancelled' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBe('user_cancelled');
  });

  it('rejects empty string guid', () => {
    const { infoHash: _, ...base } = validBase;
    const result = createBlacklistSchema.safeParse({ ...base, guid: '' });
    expect(result.success).toBe(false);
  });
});

// ===== #321 — Centralized blacklist reason enum =====

import { BLACKLIST_REASONS, REASON_LABELS, type BlacklistReason } from './blacklist.js';
import type { BlacklistEntry } from '../../client/lib/api/blacklist.js';
import type { BlacklistAndRetryRequest } from '../../server/utils/rejection-helpers.js';

// Compile-time assertions: consumer types must stay aligned with BlacklistReason.
// If BlacklistEntry.reason or BlacklistAndRetryRequest.reason diverge from BlacklistReason,
// these lines will produce a TypeScript error.
type AssertExact<T, U> = [T] extends [U] ? [U] extends [T] ? true : false : false;
type _ClientReasonIsBlacklistReason = AssertExact<BlacklistEntry['reason'], BlacklistReason> extends true ? true : never;
type _ServerReasonIsBlacklistReason = AssertExact<BlacklistAndRetryRequest['reason'], BlacklistReason> extends true ? true : never;
const _clientCheck: _ClientReasonIsBlacklistReason = true;
const _serverCheck: _ServerReasonIsBlacklistReason = true;
void _clientCheck; void _serverCheck;

describe('BLACKLIST_REASONS canonical tuple', () => {
  it('exports BLACKLIST_REASONS as a readonly tuple with all 8 reason values', () => {
    expect(BLACKLIST_REASONS).toEqual([
      'wrong_content', 'bad_quality', 'wrong_narrator', 'spam',
      'other', 'download_failed', 'infrastructure_error', 'user_cancelled',
    ]);
    expect(BLACKLIST_REASONS).toHaveLength(8);
  });

  it('blacklistReasonSchema accepts all 8 canonical reason values', () => {
    for (const reason of BLACKLIST_REASONS) {
      const result = createBlacklistSchema.safeParse({ ...validBase, reason });
      expect(result.success).toBe(true);
    }
  });

  it('blacklistReasonSchema rejects an invalid reason string', () => {
    const result = createBlacklistSchema.safeParse({ ...validBase, reason: 'fake_reason' });
    expect(result.success).toBe(false);
  });

  it('REASON_LABELS has an entry for every BlacklistReason value', () => {
    const labelKeys = Object.keys(REASON_LABELS);
    for (const reason of BLACKLIST_REASONS) {
      expect(labelKeys).toContain(reason);
      expect(typeof REASON_LABELS[reason]).toBe('string');
      expect(REASON_LABELS[reason]!.length).toBeGreaterThan(0);
    }
  });

  it('REASON_LABELS has no extra keys beyond BLACKLIST_REASONS', () => {
    const labelKeys = Object.keys(REASON_LABELS);
    expect(labelKeys).toHaveLength(BLACKLIST_REASONS.length);
  });
});
