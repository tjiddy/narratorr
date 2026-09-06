import { describe, expect, it, vi, afterEach } from 'vitest';
import { reportMigrationFailure } from './migrate.js';
import { getErrorMessage } from '@shared/error-message.js';
import { expectNoLeak, makeLeakyDrizzleError } from '../server/__tests__/drizzle-error.fixture.js';

/**
 * T46 (#2604 AC7). `pnpm db:migrate` against a schema/constraint mismatch reaches this handler in
 * normal operation, and `console.error(msg, errObject)` prints own enumerable properties — so the
 * assertion is on what was RENDERED, not on the call shape.
 */
describe('reportMigrationFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the rendered summary, never the error object', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = makeLeakyDrizzleError();

    reportMigrationFailure(err);

    expect(spy).toHaveBeenCalledTimes(1);
    const [prefix, rendered] = spy.mock.calls[0]! as [string, string];
    expect(prefix).toBe('Migration failed:');
    expect(rendered).toBe(getErrorMessage(err));
    expect(typeof rendered).toBe('string');
    expectNoLeak(rendered);
    expect(rendered).toContain('FOREIGN KEY constraint failed');
  });

  it('is unchanged for an ordinary migration failure', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    reportMigrationFailure(new Error('no such file: drizzle/0000.sql'));

    expect(spy).toHaveBeenCalledWith('Migration failed:', 'no such file: drizzle/0000.sql');
  });
});
