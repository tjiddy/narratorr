import { describe, it } from 'vitest';

describe('metadataSettingsSchema', () => {
  describe('languages field', () => {
    it.todo('accepts valid CANONICAL_LANGUAGES values');
    it.todo('defaults to [english] when omitted');
    it.todo('rejects values not in CANONICAL_LANGUAGES');
    it.todo('accepts empty array (disables filtering)');
    it.todo('rejects non-string array elements');
  });
});
