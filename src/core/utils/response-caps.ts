/**
 * Response-size caps for outbound fetches. Centralized so every hardened path
 * (fetchWithTimeout, fetchWithProxyAgent, fetchDirect, fetchViaProxy, direct
 * SSRF helpers) imports the same value and tests assert via constant rather
 * than inline byte literals.
 */

const KIB = 1024;
const MIB = 1024 * 1024;

/** Webhook, Discord, Slack, Gotify, Ntfy, Telegram, Pushover responses. */
export const RESPONSE_CAP_NOTIFIER = 64 * KIB;

/** ABS (Audiobookshelf) provider/route library + item JSON. */
export const RESPONSE_CAP_ABS = 5 * MIB;

/** Newznab/Torznab XML, MAM/ABB HTML+JSON, fetchDirect / fetchWithProxyAgent. */
export const RESPONSE_CAP_INDEXER = 10 * MIB;

/** FlareSolverr response envelope (bigger because target body is nested inside JSON). */
export const RESPONSE_CAP_FLARESOLVERR = 25 * MIB;

/** NZB / torrent file bodies via download-url, Blackhole, enrich-usenet-languages. */
export const RESPONSE_CAP_DOWNLOAD_ARTIFACT = 8 * MIB;

/** Audible / Audnexus metadata responses. */
export const RESPONSE_CAP_METADATA = 2 * MIB;

/** qBittorrent, SABnzbd, NZBGet, Transmission, Deluge RPC responses. */
export const RESPONSE_CAP_DOWNLOAD_CLIENT_RPC = 10 * MIB;
