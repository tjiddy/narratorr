import { describe, it, expect, vi } from 'vitest';

/**
 * A FOCUSED module test, separate from `api-contracts.test.ts` (#1963 AC19).
 *
 * That shared file mocks `URL_BASE` as `''`, where a broken helper returning a bare
 * `/api/books/7/companion-epub` both begins with `URL_BASE` and ends with the required path —
 * the assertion cannot fail, so it would pass while every sub-path deployment 404s. Injecting
 * a NON-EMPTY base is the only way to detect a missing prefix, and it lives here so the
 * shared contract-test mock stays at `''` and its other cases are undisturbed.
 */
vi.mock('./client.js', () => ({
  fetchApi: vi.fn().mockResolvedValue({}),
  URL_BASE: '/narratorr',
}));

import { companionEbookApi } from './companion-ebook.js';

describe('getCompanionEbookDownloadUrl', () => {
  it('prefixes the deployment URL base', () => {
    expect(companionEbookApi.getCompanionEbookDownloadUrl(7)).toBe('/narratorr/api/books/7/companion-epub');
  });
});
