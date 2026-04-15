import { describe, it } from 'vitest';

describe('normalizeInfoHash', () => {
  it.todo('converts 32-char base32 hash to 40-char lowercase hex');
  it.todo('lowercases 40-char hex hash without base32 conversion');
  it.todo('returns lowercase for mixed-case hex input');
  it.todo('silently skips invalid base32 characters in 32-char string');
});
