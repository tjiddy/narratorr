import { describe, it, expect } from 'vitest';
import { OwnedRecordingError, buildForcedImportRefusedReason } from './book-dedup.js';

// #1736 — the copy-time collision fence raises `OwnedRecordingError`; the worker's refused terminal
// disposition maps it into a structured `forced-import-refused` reason. The ownerless fence throw
// sites carry the `-1` sentinel (audio on disk, no row claims it) which must map to `null` so a
// user-facing reason never reports "book #-1".
describe('buildForcedImportRefusedReason (#1736)', () => {
  it('always sets the forced-import-refused discriminator and carries the recording reason', () => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: 7, title: 'Owned', reason: 'recording-review' }),
    );
    expect(reason.kind).toBe('forced-import-refused');
    expect(reason.recordingReason).toBe('recording-review');
  });

  // Single-owner `recording-review` and 2+-owner `recording-review-ambiguous-owner` always carry a
  // real incumbent id → keep it.
  it.each([
    'recording-review',
    'recording-review-ambiguous-owner',
  ])('keeps a real positive existingBookId for the %s variant', (variant) => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: 42, title: 'Owned', reason: variant }),
    );
    expect(reason.existingBookId).toBe(42);
    expect(reason.recordingReason).toBe(variant);
  });

  // Ownerless throw sites (`recording-review-no-disambiguator`, `recording-review-disambiguated-collision`
  // with zero path owners) carry the `-1` sentinel → must map to null.
  it.each([
    'recording-review-no-disambiguator',
    'recording-review-disambiguated-collision',
  ])('maps the -1 sentinel to null for the ownerless %s variant', (variant) => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: -1, title: 'New Recording', reason: variant }),
    );
    expect(reason.existingBookId).toBeNull();
    expect(reason.recordingReason).toBe(variant);
  });

  it('maps any non-positive id (0) to null, never reporting a bogus owner', () => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: 0, title: 'X', reason: 'recording-review-no-disambiguator' }),
    );
    expect(reason.existingBookId).toBeNull();
  });
});
