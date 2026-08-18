/**
 * The URL rules for the ABB adapter: every scraped link is re-composed onto the operator's
 * configured origin, and the row's persisted identity is derived from the path alone.
 *
 * Two things follow from that, and both are the point (#2434). ABB rate-limits per site, so a
 * detail link whose raw markup disagrees with `baseUrl` on scheme or www would otherwise key its
 * own throttle queue and halve the 6.1s floor — rewriting converges the key upstream of
 * `abbThrottleKey`, which is why that helper needs no widening. And ABB's mirrors rotate, so a
 * host-bearing guid is invalidated by a config change alone, taking every blacklist entry with it.
 *
 * Pure and I/O-free, so a spelling can be diagnosed with `pnpm exec tsx` and a small script file
 * (the inline `-e` form cannot resolve the `@core` alias on Windows).
 */

/**
 * `href` resolved against `baseUrl` and re-composed on `baseUrl`'s origin, or `undefined` when the
 * result cannot address an ABB page at all — either the `URL` constructor rejected the input, or it
 * resolved to a scheme other than http(s).
 *
 * The output is composed as a string rather than by assigning `url.protocol` / `url.host`: those
 * setters are no-ops on an opaque-path URL, so a `javascript:` href would survive the guard.
 */
export function rewriteAbbUrl(href: string, baseUrl: string): string | undefined {
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(href, base);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    return `${base.origin}${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether a rewritten URL addresses the bare site root and therefore no release.
 *
 * A property of the resolved URL, deliberately not a list of bad href spellings: `#`, `/`, `/.`,
 * `"   "` and an off-host hash-routed link all collapse here, and so does every spelling nobody has
 * named yet. It stops at the root — `/?p=12345` is a real WordPress default permalink, and
 * over-rejecting would make genuine releases unobtainable on the one indexer where a wasted grab is
 * most expensive. The fragment is not consulted: `abbGuid` drops it, so `#a` and `#b` would
 * otherwise be two rows sharing one identity.
 */
export function isAbbRootUrl(rewrittenUrl: string): boolean {
  const url = new URL(rewrittenUrl);
  return url.pathname === '/' && url.search === '';
}

/**
 * The host-independent persisted identity of an ABB release: no scheme, no host, no fragment.
 *
 * The `abb:` prefix is not decoration — `blacklist.guid` is unique across every indexer, so a bare
 * `/audio-books/x/` could collide with another adapter's guid.
 */
export function abbGuid(rewrittenUrl: string): string {
  const url = new URL(rewrittenUrl);
  return `abb:${url.pathname}${url.search}`;
}
