import { describe, it, expect, vi } from 'vitest';
import { clientSubmissionIdSchema } from '../../../core/import-staging/schemas.js';
import { generateClientSubmissionId, EntropyUnavailableError } from './client-uuid.js';

/** A deterministic getRandomValues that fills the buffer with an incrementing pattern. */
function fixedGetRandomValues(seed = 1) {
  return (arr: Uint8Array) => {
    for (let i = 0; i < arr.length; i++) arr[i] = (seed + i) & 0xff;
    return arr;
  };
}

describe('generateClientSubmissionId', () => {
  it('uses crypto.randomUUID on a secure context', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    const id = generateClientSubmissionId({ randomUUID } as unknown as Crypto);
    expect(randomUUID).toHaveBeenCalledOnce();
    expect(id).toBe('11111111-2222-4333-8444-555555555555');
    expect(clientSubmissionIdSchema.safeParse(id).success).toBe(true);
  });

  it('falls back to a schema-valid v4 with correct version/variant bits when randomUUID is absent', () => {
    const impl = { getRandomValues: vi.fn(fixedGetRandomValues(0)) } as unknown as Crypto;
    const id = generateClientSubmissionId(impl);
    expect(clientSubmissionIdSchema.safeParse(id).success).toBe(true);
    // version nibble (first char of 3rd group) is 4; variant nibble (first char of 4th group) is 8/9/a/b.
    const groups = id.split('-');
    expect(groups[2]![0]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(groups[3]![0]);
  });

  it('produces a valid v4 even for all-zero entropy (bits still set)', () => {
    const impl = { getRandomValues: (arr: Uint8Array) => arr } as unknown as Crypto;
    const id = generateClientSubmissionId(impl);
    expect(clientSubmissionIdSchema.safeParse(id).success).toBe(true);
    expect(id.split('-')[2]![0]).toBe('4');
  });

  it('throws a visible error when no entropy source exists', () => {
    expect(() => generateClientSubmissionId({} as unknown as Crypto)).toThrow(EntropyUnavailableError);
  });
});
