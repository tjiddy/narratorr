import { DownloadClientError } from './errors.js';

/**
 * `downloads.external_id` is nullable text and every server-side caller guards on FALSY, so a
 * whitespace-only id clears all of them and reaches whichever adapter is configured (#2485, #2488).
 * The `.trim()` is the load-bearing part — `'   '` is truthy.
 */
export function normalizeExternalId(id: string): string | undefined {
  return id.trim() || undefined;
}

/**
 * The single refusal an adapter raises for an external ID it cannot safely act on. Reads resolve
 * `null` instead of raising this: `monitor`'s per-download `catch` escalates a thrown read through
 * `blacklistOnInfraError`, while a `null` takes the intended missing-item path
 * (`src/server/jobs/monitor.ts:65-87`).
 */
export function externalIdRefusal(
  clientName: string,
  detail = 'it is blank — empty or whitespace-only',
): DownloadClientError {
  return new DownloadClientError(
    clientName,
    `Refusing to act on the stored external ID: ${detail}. Repair or cancel the download record before retrying.`,
  );
}
