import { describe, it, expect } from 'vitest';
import { RateLimitError, TransientError, MetadataError } from '@core/metadata/errors.js';
import { mapHardcoverError } from './hardcover-error.js';

const INVALID_KEY_HINT =
  'Invalid Hardcover API key. (If you copied from the Hardcover docs, drop the "Bearer " prefix.)';

const metadataError = (message: string) => new MetadataError('hardcover', message);

describe('mapHardcoverError', () => {
  describe('under-scoped tokens get scope guidance, not the re-paste hint (#2537 AC5)', () => {
    it('names the missing scope when the body supplied one', () => {
      const message = mapHardcoverError(metadataError(
        'Hardcover API returned 403: Forbidden (error: insufficient_scope; scope: read:series)',
      ));

      expect(message).toContain('scope');
      expect(message).toContain('read:series');
      expect(message).not.toBe(INVALID_KEY_HINT);
    });

    it('still guides on scope when the body named no scope, with no undefined/null placeholder', () => {
      const message = mapHardcoverError(metadataError(
        'Hardcover API returned 403: Forbidden (error: insufficient_scope)',
      ));

      expect(message).toContain('scope');
      expect(message).not.toBe(INVALID_KEY_HINT);
      expect(message).not.toMatch(/undefined|null/);
    });

    // The 403 arm would otherwise shadow the scope arm, which is the whole point of the ordering.
    it('wins over the 401/403 arm for a message that satisfies both', () => {
      const bothArms = metadataError(
        'Hardcover API returned 403: Forbidden (error: insufficient_scope; scope: read:lists)',
      );

      expect(mapHardcoverError(bothArms)).toContain('read:lists');
      expect(mapHardcoverError(bothArms)).not.toBe(INVALID_KEY_HINT);
    });
  });

  describe('the existing invalid-key guidance is unchanged', () => {
    it.each([
      ['a 403 with no scope detail', 'Hardcover API returned 403: Forbidden'],
      ['a 401', 'Hardcover API returned 401: Unauthorized'],
      ['a 200-envelope JWT failure', 'Hardcover search error: Could not verify JWT: signature mismatch'],
      ['a 200-envelope malformed header', 'Hardcover search error: Malformed Authorization header'],
      ['a 200-envelope unauthorized', 'Hardcover GraphQL error: unauthorized'],
      ['a 401 naming invalid_token', 'Hardcover API returned 401: Unauthorized (error: invalid_token)'],
    ])('%s maps to the Bearer-paste hint', (_label, message) => {
      expect(mapHardcoverError(metadataError(message))).toBe(INVALID_KEY_HINT);
    });
  });

  describe('the other arms are untouched', () => {
    // Rate limiting is recognized BY TYPE, so the metadata client can keep RateLimitError's fixed
    // message — which carries neither the status nor the upstream body — without losing guidance.
    it('renders a RateLimitError as the retry hint even though its message has no status', () => {
      const error = new RateLimitError(5000, 'hardcover');

      expect(error.message).not.toContain('429');
      expect(mapHardcoverError(error)).toBe('Hardcover is rate-limiting requests. Try again in 5s.');
    });

    it('renders a TransientError as the network hint', () => {
      expect(mapHardcoverError(new TransientError('hardcover', 'ECONNRESET')))
        .toBe("Couldn't reach Hardcover. Check your network and try again.");
    });

    it('passes an unrecognized MetadataError message through verbatim', () => {
      expect(mapHardcoverError(metadataError('Hardcover returned unexpected response: bad shape')))
        .toBe('Hardcover returned unexpected response: bad shape');
    });

    it('falls back to getErrorMessage for an unknown error', () => {
      expect(mapHardcoverError(new Error('something else'))).toBe('something else');
    });
  });
});
