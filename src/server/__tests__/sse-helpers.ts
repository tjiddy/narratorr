import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';

export type SseEvent = {
  event: string;
  data: unknown;
  rawData: string;
};

export type FetchSseResult = {
  status: number;
  headers: Headers;
  body: string;
  events: SseEvent[];
};

/**
 * Parse an SSE response body into ordered events.
 *
 * Walks ALL `\n\n`-delimited frames (CRLF normalised to LF), so callers can
 * assert on every event in the stream rather than the first regex match. Each
 * frame may contribute zero or one entries to the returned array — a frame
 * with no `data:` field (pure `:` comment, lone `event:` line) is skipped.
 *
 * Per the SSE spec, multiple `data:` lines in a single frame are joined with
 * `\n`. The joined string is JSON-parsed when valid; on parse failure (or for
 * non-JSON wire formats) `data` falls back to the raw joined string and the
 * frame is still emitted. `rawData` always holds the raw joined `data:`
 * string so tests can assert on exact wire format when JSON key ordering or
 * whitespace matters. If `event:` is omitted in a frame, `event` defaults to
 * `'message'` per the spec.
 *
 * The trailing frame is emitted even if the body ends without `\n\n` — SSE
 * routes that call `reply.raw.end()` may flush a final frame mid-delimiter.
 */
export function parseSseFrames(body: string): SseEvent[] {
  const events: SseEvent[] = [];
  const normalised = body.replace(/\r\n/g, '\n');

  for (const frame of normalised.split('\n\n')) {
    if (frame.length === 0) continue;

    let eventName: string | null = null;
    const dataLines: string[] = [];

    for (const line of frame.split('\n')) {
      if (line.length === 0 || line.startsWith(':')) continue;
      const colonIndex = line.indexOf(':');
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (dataLines.length === 0) continue;

    const rawData = dataLines.join('\n');
    let data: unknown;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }

    events.push({ event: eventName ?? 'message', data, rawData });
  }

  return events;
}

/**
 * Real-HTTP SSE test helper for hijacked Fastify streams.
 *
 * Fastify's `app.inject()` hangs on routes that call `reply.hijack()` and
 * write to `reply.raw` (the SSE pattern), so each test would otherwise
 * hand-roll: bind on port 0, fetch the path, parse `event:`/`data:` frames.
 * This helper centralises that boilerplate.
 *
 * **Ownership of `app.close()` is the caller's** — typically in `afterEach`
 * or a `try/finally`. The helper does not close the app even on error; doing
 * so would silently swallow misuse (e.g. forgetting to clean up a session
 * manager). The helper WILL call `app.listen({ port: 0, host: '127.0.0.1' })`
 * if the app is not already listening, so callers can drop their own
 * `await app.listen(...)` line.
 *
 * **Finite streams only.** The helper awaits `res.text()` to completion,
 * which never resolves on an unclosed stream. Mock the upstream so the route
 * eventually calls `reply.raw.end()`. Pointing this at a live indexer URL
 * silently hangs the test.
 *
 * The returned `headers` is the Fetch API `Headers` instance directly off the
 * response — not a rebuilt object — so case-insensitive lookups via
 * `headers.get('content-type')` work as expected.
 */
export async function fetchSseEvents(app: FastifyInstance, path: string): Promise<FetchSseResult> {
  if (!app.server.listening) {
    await app.listen({ port: 0, host: '127.0.0.1' });
  }
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}${path}`;

  const res = await fetch(url);
  const body = await res.text();
  const events = parseSseFrames(body);

  return { status: res.status, headers: res.headers, body, events };
}
