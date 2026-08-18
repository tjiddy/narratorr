/**
 * ABB search rows carry no info hash — the hash lives on the detail page, and fetching one per row
 * at search time is what earned the 2026-08 ban (#2420). The row therefore ships a sentinel that
 * `resolveDownloadUrl` trades for a magnet at grab time, mirroring `mam-wedge.ts`.
 *
 * The details URL is carried verbatim after the prefix rather than encoded: every downstream
 * consumer treats `downloadUrl` as an opaque non-empty string until the resolve hook runs, so a
 * lossless concatenation is both sufficient and the only form with no escaping to get wrong.
 */

/** Sentinel prefix for ABB results; the real magnet is built from the detail page at grab time. */
export const ABB_DETAILS_SENTINEL_PREFIX = 'abb-details://';

/** Greedy to end-of-string so a query, a fragment and percent-encoding all survive the capture. */
const ABB_SENTINEL_PATTERN = /^abb-details:\/\/(\S.*)$/;

/** The details URL a sentinel carries, or `undefined` for any other download URL. */
export function parseAbbDetailsUrl(downloadUrl: string): string | undefined {
  return ABB_SENTINEL_PATTERN.exec(downloadUrl)?.[1];
}

export function abbDetailsSentinel(detailsUrl: string): string {
  return `${ABB_DETAILS_SENTINEL_PREFIX}${detailsUrl}`;
}
