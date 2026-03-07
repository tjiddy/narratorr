/**
 * Shared MSW handler factories for E2E flow tests.
 * Each factory returns an MSW handler that can be passed to setupServer.use() or server.use().
 */
import { http, HttpResponse } from 'msw';

// ─── Constants ──────────────────────────────────────────────────────────

export const QB_BASE = 'http://localhost:8080';
export const INDEXER_BASE = 'http://indexer.test';
export const WEBHOOK_URL = 'http://webhook.test/hook';
export const WEBHOOK_URL_2 = 'http://webhook.test/hook2';
export const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123456/test-token';

export const TORRENT_HASH = 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d';

export const TORZNAB_SEARCH_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Test Indexer</title>
    <item>
      <title>The Way of Kings - Brandon Sanderson (Unabridged)</title>
      <guid isPermaLink="true">https://tracker.test/details/abc123</guid>
      <link>https://tracker.test/download/abc123.torrent</link>
      <enclosure url="https://tracker.test/download/abc123.torrent" length="1073741824" type="application/x-bittorrent"/>
      <torznab:attr name="size" value="1073741824"/>
      <torznab:attr name="seeders" value="15"/>
      <torznab:attr name="leechers" value="3"/>
      <torznab:attr name="grabs" value="42"/>
      <torznab:attr name="infohash" value="${TORRENT_HASH}"/>
    </item>
  </channel>
</rss>`;

// ─── qBittorrent Handlers ───────────────────────────────────────────────

export function qbLoginHandler(base = QB_BASE) {
  return http.post(`${base}/api/v2/auth/login`, () => {
    return new HttpResponse('Ok.', {
      headers: { 'Set-Cookie': 'SID=test-session-id; path=/' },
    });
  });
}

export function qbAddTorrentHandler(base = QB_BASE) {
  return http.post(`${base}/api/v2/torrents/add`, () => {
    return new HttpResponse('');
  });
}

export function qbAddTorrentErrorHandler(status = 500, base = QB_BASE) {
  return http.post(`${base}/api/v2/torrents/add`, () => {
    return new HttpResponse('Error', { status });
  });
}

export function qbLoginErrorHandler(status = 500, base = QB_BASE) {
  return http.post(`${base}/api/v2/auth/login`, () => {
    return new HttpResponse('Error', { status });
  });
}

export function qbGetTorrentHandler(hash: string, savePath = '/downloads/book', base = QB_BASE) {
  return http.get(`${base}/api/v2/torrents/info`, ({ request }) => {
    const url = new URL(request.url);
    const hashes = url.searchParams.get('hashes');
    if (hashes && hashes.toLowerCase() === hash.toLowerCase()) {
      return HttpResponse.json([{
        hash: hash.toLowerCase(),
        name: 'Test Audiobook',
        save_path: savePath,
        content_path: `${savePath}/Test Audiobook`,
        state: 'uploading',
        progress: 1,
        size: 1073741824,
        added_on: Math.floor(Date.now() / 1000) - 86400,
        completion_on: Math.floor(Date.now() / 1000) - 3600,
      }]);
    }
    return HttpResponse.json([]);
  });
}

export function qbDeleteTorrentHandler(base = QB_BASE) {
  return http.post(`${base}/api/v2/torrents/delete`, () => {
    return new HttpResponse('');
  });
}

// ─── Torznab Indexer Handlers ───────────────────────────────────────────

export function torznabSearchHandler(apiUrl = INDEXER_BASE, xml = TORZNAB_SEARCH_XML) {
  return http.get(`${apiUrl}/api`, () => {
    return new HttpResponse(xml, {
      headers: { 'Content-Type': 'application/rss+xml' },
    });
  });
}

// ─── Webhook Handlers ───────────────────────────────────────────────────

export interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Creates a webhook handler that captures requests for later assertion.
 * Returns the handler and the captured requests array.
 */
export function webhookCaptureHandler(url = WEBHOOK_URL): {
  handler: ReturnType<typeof http.post>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const handler = http.post(url, async ({ request }) => {
    const body = await request.json();
    captured.push({
      url: request.url,
      method: request.method,
      body,
      headers: Object.fromEntries(request.headers.entries()),
    });
    return new HttpResponse(null, { status: 200 });
  });
  return { handler, captured };
}

/**
 * Creates a Discord webhook handler that captures requests for later assertion.
 * Returns 204 (Discord's success response).
 */
export function discordCaptureHandler(url = DISCORD_WEBHOOK_URL): {
  handler: ReturnType<typeof http.post>;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const handler = http.post(url, async ({ request }) => {
    const body = await request.json();
    captured.push({
      url: request.url,
      method: request.method,
      body,
      headers: Object.fromEntries(request.headers.entries()),
    });
    return new HttpResponse(null, { status: 204 });
  });
  return { handler, captured };
}

/**
 * Polls until at least `count` requests have been captured, with a bounded timeout.
 * Throws if timeout is reached.
 */
export async function waitForRequests(
  captured: CapturedRequest[],
  count: number,
  timeoutMs = 2000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (captured.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (captured.length < count) {
    throw new Error(
      `Timed out waiting for ${count} captured request(s), got ${captured.length} after ${timeoutMs}ms`,
    );
  }
}
