import { describe, it, expect, vi } from 'vitest';

/** A non-empty URL_BASE catches the missing-prefix bug that the shared empty-base mock cannot (#1963 AC19). */
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
