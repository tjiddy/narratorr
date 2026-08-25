import { expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';

/**
 * The #2604 leak fixture: a real `DrizzleQueryError` whose bound params carry a MAM-style
 * `data:` torrent URI. Its decoded announce URL contains the operator's tracker passkey, so
 * `error.message` — `Failed query: <sql>\nparams: <values>` — is a passkey disclosure.
 *
 * Shared across the shared/server/lint suites so every "contains no passkey" assertion is driven
 * by the same stimulus; a per-suite hand-rolled fixture is how one of them ends up inert.
 */

export const PASSKEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

export const TRACKER_ANNOUNCE_URL = `http://tracker.myanonamouse.net/tracker.php/${PASSKEY}/announce`;

/** The base64 body only — the substring a redactor that stops at `data:` would leave behind. */
export const TORRENT_BASE64 = Buffer.from(
  `d8:announce${TRACKER_ANNOUNCE_URL.length}:${TRACKER_ANNOUNCE_URL}4:infod4:name5:booke`,
).toString('base64');

export const LEAKY_DOWNLOAD_URL = `data:application/x-bittorrent;base64,${TORRENT_BASE64}`;

/**
 * Every substring that must not survive to a client body, a durable row, or a log record.
 * `Failed query:` / `params:` are the raw-message tells; the other three are the disclosure itself.
 */
export const LEAK_SUBSTRINGS = [
  TORRENT_BASE64,
  'tracker.php',
  PASSKEY,
  'Failed query:',
  'params:',
] as const;

export interface LeakyDrizzleErrorOptions {
  query?: string;
  cause?: Error;
}

const DEFAULT_QUERY =
  'insert into "downloads" ("public_id", "book_id", "title", "download_url", "status") values (?, ?, ?, ?, ?) returning "id"';

const DEFAULT_CAUSE = (): Error =>
  Object.assign(new Error('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed'), {
    code: 'SQLITE_CONSTRAINT',
    rawCode: 787,
  });

/** A real drizzle wrapper, not a hand-shaped stand-in — the duck-type under test is its own-property set. */
export function makeLeakyDrizzleError(options: LeakyDrizzleErrorOptions = {}): Error {
  return new DrizzleQueryError(
    options.query ?? DEFAULT_QUERY,
    ['dl_01HZ', 1716, 'Some Book', LEAKY_DOWNLOAD_URL, 'downloading'],
    options.cause ?? DEFAULT_CAUSE(),
  );
}

/** Fails naming the offending substring, so a red points at the leak rather than at a length diff. */
export function expectNoLeak(text: string): void {
  for (const needle of LEAK_SUBSTRINGS) {
    expect(text).not.toContain(needle);
  }
}
