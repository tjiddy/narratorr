import { describe, it, expect } from 'vitest';
import { FIELD_ORDER } from './RetagPreviewModal.utils';
import { RETAG_EXCLUDABLE_FIELDS } from '../../shared/schemas.js';

describe('RetagPreviewModal.utils FIELD_ORDER', () => {
  // Guards against drift now that the client no longer redeclares the field
  // union — a field added to (or removed from) the shared `RETAG_EXCLUDABLE_FIELDS`
  // must also appear in `FIELD_ORDER`, or it silently vanishes from the preview.
  // Membership only (set equality), not display sequence.
  it('covers exactly the shared RETAG_EXCLUDABLE_FIELDS set', () => {
    expect(new Set(FIELD_ORDER)).toEqual(new Set(RETAG_EXCLUDABLE_FIELDS));
  });
});
