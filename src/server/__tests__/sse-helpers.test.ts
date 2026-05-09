import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { parseSseFrames, fetchSseEvents } from './sse-helpers.js';

describe('parseSseFrames', () => {
  it('walks all `\\n\\n`-delimited frames in order', () => {
    const body =
      'event: a\ndata: {"n":1}\n\n' +
      'event: b\ndata: {"n":2}\n\n' +
      'event: c\ndata: {"n":3}\n\n';

    const events = parseSseFrames(body);

    expect(events).toEqual([
      { event: 'a', data: { n: 1 }, rawData: '{"n":1}' },
      { event: 'b', data: { n: 2 }, rawData: '{"n":2}' },
      { event: 'c', data: { n: 3 }, rawData: '{"n":3}' },
    ]);
  });

  it('matches the legacy parseSearchComplete regex behaviour for a single frame', () => {
    const body = 'event: search-complete\ndata: {"results":[],"durationUnknown":false}\n\n';
    const events = parseSseFrames(body);
    const complete = events.find(e => e.event === 'search-complete');
    expect(complete?.data).toEqual({ results: [], durationUnknown: false });
  });

  it('emits the trailing frame even when the body ends without `\\n\\n`', () => {
    const body = 'event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}';
    const events = parseSseFrames(body);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ event: 'b', data: { n: 2 }, rawData: '{"n":2}' });
  });

  it('does not throw on a non-JSON `data:` payload — falls back to raw string', () => {
    const body = 'event: text\ndata: hello world\n\n';
    const events = parseSseFrames(body);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'text', data: 'hello world', rawData: 'hello world' });
  });

  it('returns an empty array for an empty body', () => {
    expect(parseSseFrames('')).toEqual([]);
  });

  it('preserves rawData for assertions on exact wire format', () => {
    const body = 'event: a\ndata: {"key":"value","n":1}\n\n';
    const events = parseSseFrames(body);
    expect(events[0]?.rawData).toBe('{"key":"value","n":1}');
  });

  it('joins multi-line `data:` payloads with `\\n` per the SSE spec', () => {
    const body = 'event: multi\ndata: line one\ndata: line two\n\n';
    const events = parseSseFrames(body);
    expect(events[0]).toEqual({
      event: 'multi',
      data: 'line one\nline two',
      rawData: 'line one\nline two',
    });
  });

  it('defaults `event` to `message` when the frame omits the event field', () => {
    const body = 'data: {"n":1}\n\n';
    const events = parseSseFrames(body);
    expect(events[0]?.event).toBe('message');
  });

  it('skips comment lines starting with `:` and frames with no data field', () => {
    const body = ': heartbeat\n\nevent: ping\n\nevent: real\ndata: {"n":1}\n\n';
    const events = parseSseFrames(body);
    expect(events).toEqual([{ event: 'real', data: { n: 1 }, rawData: '{"n":1}' }]);
  });

  it('normalises CRLF line endings to LF before parsing', () => {
    const body = 'event: a\r\ndata: {"n":1}\r\n\r\nevent: b\r\ndata: {"n":2}\r\n\r\n';
    const events = parseSseFrames(body);
    expect(events).toEqual([
      { event: 'a', data: { n: 1 }, rawData: '{"n":1}' },
      { event: 'b', data: { n: 2 }, rawData: '{"n":2}' },
    ]);
  });
});

describe('fetchSseEvents', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  function buildSseApp(write: (reply: import('fastify').FastifyReply) => void): FastifyInstance {
    const instance = Fastify({ logger: false });
    instance.get('/sse', async (_req, reply) => {
      reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' });
      reply.hijack();
      write(reply);
      reply.raw.end();
    });
    return instance;
  }

  it('starts the app on an ephemeral port when not already listening', async () => {
    app = buildSseApp((reply) => {
      reply.raw.write('event: ready\ndata: {"ok":true}\n\n');
    });

    const result = await fetchSseEvents(app, '/sse');

    expect(app.server.listening).toBe(true);
    const port = (app.server.address() as { port: number }).port;
    expect(port).toBeGreaterThan(0);
    expect(result.status).toBe(200);
    expect(result.events).toEqual([{ event: 'ready', data: { ok: true }, rawData: '{"ok":true}' }]);
  });

  it('reuses an already-listening server without rebinding', async () => {
    app = buildSseApp((reply) => {
      reply.raw.write('event: ready\ndata: {"ok":true}\n\n');
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const portBefore = (app.server.address() as { port: number }).port;

    await fetchSseEvents(app, '/sse');

    const portAfter = (app.server.address() as { port: number }).port;
    expect(portAfter).toBe(portBefore);
  });

  it('returns the Fetch API Headers instance directly off the response', async () => {
    app = buildSseApp((reply) => {
      reply.raw.write('event: ready\ndata: {}\n\n');
    });

    const { headers } = await fetchSseEvents(app, '/sse');

    expect(headers).toBeInstanceOf(Headers);
    expect(headers.get('content-type')).toBe('text/event-stream');
  });

  it('preserves the raw response body alongside the parsed events', async () => {
    app = buildSseApp((reply) => {
      reply.raw.write('event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n');
    });

    const { body, events } = await fetchSseEvents(app, '/sse');

    expect(body).toContain('event: a');
    expect(body).toContain('event: b');
    expect(events.map(e => e.event)).toEqual(['a', 'b']);
  });
});
