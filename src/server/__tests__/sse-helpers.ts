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
 * Parse ordered SSE frames, joining data lines and defaulting unnamed events to `message`.
 * JSON-decode when possible while retaining rawData; include an unterminated trailing frame.
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
 * Use real HTTP because inject hangs on hijacked streams. The caller owns app.close(), and the
 * upstream must close the finite stream because this helper awaits the full response body.
 */
export async function fetchSseEvents(
  app: FastifyInstance,
  path: string,
  init?: RequestInit,
): Promise<FetchSseResult> {
  if (!app.server.listening) {
    await app.listen({ port: 0, host: '127.0.0.1' });
  }
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}${path}`;

  const res = await fetch(url, init);
  const body = await res.text();
  const events = parseSseFrames(body);

  return { status: res.status, headers: res.headers, body, events };
}
