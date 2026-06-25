import { describe, it, expect } from 'vitest';
import { bookStatusConfig, bookStatusChipStyles } from './status.js';
import type { BookStatusStyle } from './status.js';
import { BOOK_STATUSES } from '../../shared/schemas/book.js';

// Verify the interface is exported (compile-time check — if this import fails, the test file won't compile)
// PHASE 1 SKIPPED — needs human review
const _typeCheck: BookStatusStyle = bookStatusConfig.wanted;
void _typeCheck;

describe('bookStatusConfig', () => {
  const ALL_STATUSES = ['wanted', 'searching', 'downloading', 'importing', 'imported', 'missing', 'failed'] as const;

  it('has entries for all 7 statuses', () => {
    for (const status of ALL_STATUSES) {
      expect(bookStatusConfig[status]).toBeDefined();
    }
  });

  // #1447 (S2d) — drift guard: the badge config keys must set-equal the canonical
  // BookStatus set, so a future status can't render with an empty/fallback style.
  it('keys set-equal BOOK_STATUSES (no drift, no fallback masking)', () => {
    expect(Object.keys(bookStatusConfig).sort()).toEqual([...BOOK_STATUSES].sort());
  });

  it('renders each canonical status with its own first-class config (no wanted fallback)', () => {
    for (const status of BOOK_STATUSES) {
      const entry = bookStatusConfig[status];
      expect(entry).toBeDefined();
      // Non-`wanted` statuses must not coincidentally equal the `wanted` config,
      // which would mean a missing entry was being masked by a fallback.
      if (status !== 'wanted') {
        expect(entry).not.toBe(bookStatusConfig.wanted);
      }
    }
  });

  it('each entry has label, dotClass, textClass, and barClass', () => {
    for (const status of ALL_STATUSES) {
      const entry = bookStatusConfig[status];
      expect(entry).toHaveProperty('label');
      expect(entry).toHaveProperty('dotClass');
      expect(entry).toHaveProperty('textClass');
      expect(entry).toHaveProperty('barClass');
      expect(typeof entry!.label).toBe('string');
      expect(typeof entry!.dotClass).toBe('string');
      expect(typeof entry!.textClass).toBe('string');
      expect(typeof entry!.barClass).toBe('string');
    }
  });

  it('wanted uses stone palette', () => {
    // PHASE 1 SKIPPED — needs human review
    const { dotClass, textClass, barClass } = bookStatusConfig.wanted;
    expect(dotClass).toContain('stone');
    expect(textClass).toContain('stone');
    expect(barClass).toContain('stone');
  });

  it('searching uses sky palette', () => {
    // PHASE 1 SKIPPED — needs human review
    const { dotClass, textClass, barClass } = bookStatusConfig.searching;
    expect(dotClass).toContain('sky');
    expect(textClass).toContain('sky');
    expect(barClass).toContain('sky');
  });

  it('downloading uses violet palette', () => {
    // PHASE 1 SKIPPED — needs human review
    const { dotClass, textClass, barClass } = bookStatusConfig.downloading;
    expect(dotClass).toContain('violet');
    expect(textClass).toContain('violet');
    expect(barClass).toContain('violet');
  });

  it('importing uses amber palette', () => {
    // PHASE 1 SKIPPED — needs human review
    const { dotClass, textClass, barClass } = bookStatusConfig.importing;
    expect(dotClass).toContain('amber');
    expect(textClass).toContain('amber');
    expect(barClass).toContain('amber');
  });

  it('imported uses emerald palette', () => {
    // PHASE 1 SKIPPED — needs human review
    const { dotClass, textClass, barClass } = bookStatusConfig.imported;
    expect(dotClass).toContain('emerald');
    expect(textClass).toContain('emerald');
    expect(barClass).toContain('emerald');
  });

  it('missing uses rose palette', () => {
    // PHASE 1 SKIPPED — needs human review
    const { dotClass, textClass, barClass } = bookStatusConfig.missing;
    expect(dotClass).toContain('rose');
    expect(textClass).toContain('rose');
    expect(barClass).toContain('rose');
  });

  it('failed uses rose palette', () => {
    // PHASE 1 SKIPPED — needs human review
    const { dotClass, textClass, barClass } = bookStatusConfig.failed;
    expect(dotClass).toContain('rose');
    expect(textClass).toContain('rose');
    expect(barClass).toContain('rose');
  });

  // #1447 (S2d) — second status-style renderer (library table chip) carries the
  // same drift guard, so neither status-style map can fall behind BOOK_STATUSES.
  it('bookStatusChipStyles keys set-equal BOOK_STATUSES', () => {
    expect(Object.keys(bookStatusChipStyles).sort()).toEqual([...BOOK_STATUSES].sort());
  });

  it('active statuses have shimmer in barClass', () => {
    expect(bookStatusConfig.searching!.barClass).toContain('status-bar-shimmer');
    expect(bookStatusConfig.downloading!.barClass).toContain('status-bar-shimmer');
    expect(bookStatusConfig.importing!.barClass).toContain('status-bar-shimmer');
  });

  it('static statuses do not have shimmer in barClass', () => {
    expect(bookStatusConfig.wanted!.barClass).not.toContain('status-bar-shimmer');
    expect(bookStatusConfig.imported!.barClass).not.toContain('status-bar-shimmer');
    expect(bookStatusConfig.missing!.barClass).not.toContain('status-bar-shimmer');
    expect(bookStatusConfig.failed!.barClass).not.toContain('status-bar-shimmer');
  });

  it('active statuses have animate-pulse in dotClass', () => {
    expect(bookStatusConfig.searching!.dotClass).toContain('animate-pulse');
    expect(bookStatusConfig.downloading!.dotClass).toContain('animate-pulse');
    expect(bookStatusConfig.importing!.dotClass).toContain('animate-pulse');
  });

  it('static statuses do not have animate-pulse in dotClass', () => {
    expect(bookStatusConfig.wanted!.dotClass).not.toContain('animate-pulse');
    expect(bookStatusConfig.imported!.dotClass).not.toContain('animate-pulse');
    expect(bookStatusConfig.missing!.dotClass).not.toContain('animate-pulse');
    expect(bookStatusConfig.failed!.dotClass).not.toContain('animate-pulse');
  });
});
