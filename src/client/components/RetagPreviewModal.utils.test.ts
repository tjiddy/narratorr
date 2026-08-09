import { describe, it, expect } from 'vitest';
import { FIELD_ORDER } from './RetagPreviewModal.utils';
import { RETAG_EXCLUDABLE_FIELDS } from '@shared/schemas.js';

describe('RetagPreviewModal.utils FIELD_ORDER', () => {
  // Set equality pins display coverage to the shared field registry, independent of order.
  it('covers exactly the shared RETAG_EXCLUDABLE_FIELDS set', () => {
    expect(new Set(FIELD_ORDER)).toEqual(new Set(RETAG_EXCLUDABLE_FIELDS));
  });
});
