import { describe, it, expect } from 'vitest';
import { readBodyWithCap } from './read-body-with-cap.js';

const SMALL_CAP = 1024;

describe('readBodyWithCap', () => {
  describe('Content-Length precheck', () => {
    it('throws before reading body when Content-Length > cap', async () => {
      // Construct a Response whose declared Content-Length exceeds the cap
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new Error('body should not be read when CL > cap'));
        },
      });
      const response = new Response(stream, {
        status: 200,
        headers: { 'content-length': String(SMALL_CAP + 1) },
      });
      await expect(readBodyWithCap(response, SMALL_CAP)).rejects.toThrow(/exceeds cap/);
    });

    it('does not invoke the reader when Content-Length precheck fires', async () => {
      let pulled = false;
      const stream = new ReadableStream({
        pull() {
          pulled = true;
        },
      });
      const response = new Response(stream, {
        status: 200,
        headers: { 'content-length': String(SMALL_CAP + 1) },
      });
      await expect(readBodyWithCap(response, SMALL_CAP)).rejects.toThrow();
      expect(pulled).toBe(false);
    });

    it('proceeds when Content-Length is exactly the cap', async () => {
      const data = new Uint8Array(SMALL_CAP);
      const response = new Response(data, {
        status: 200,
        headers: { 'content-length': String(SMALL_CAP) },
      });
      const buffer = await readBodyWithCap(response, SMALL_CAP);
      expect(buffer.length).toBe(SMALL_CAP);
    });
  });

  describe('streamed overflow', () => {
    it('cancels the reader and throws when stream exceeds cap mid-read', async () => {
      let cancelled = false;
      const overflowChunk = new Uint8Array(SMALL_CAP + 1);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(overflowChunk);
          // Keep the stream open so reader.cancel() reaches the source's
          // cancel hook — once a stream is closed, cancel is a no-op.
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = new Response(stream, {
        status: 200,
        // No Content-Length — server lying / chunked transfer
      });
      await expect(readBodyWithCap(response, SMALL_CAP)).rejects.toThrow(/Streamed body exceeded cap/);
      expect(cancelled).toBe(true);
    });

    it('throws even when individual chunks are under the cap but total exceeds', async () => {
      const halfCap = Math.floor(SMALL_CAP / 2);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(halfCap));
          controller.enqueue(new Uint8Array(halfCap));
          controller.enqueue(new Uint8Array(2)); // pushes total over the cap
          controller.close();
        },
      });
      const response = new Response(stream, { status: 200 });
      await expect(readBodyWithCap(response, SMALL_CAP)).rejects.toThrow(/exceeded cap/);
    });
  });

  describe('under-cap happy path', () => {
    it('returns the full body as a Buffer with bytes intact', async () => {
      const payload = Buffer.from('hello world');
      const response = new Response(payload, {
        status: 200,
        headers: { 'content-length': String(payload.length) },
      });
      const buffer = await readBodyWithCap(response, SMALL_CAP);
      expect(Buffer.compare(buffer, payload)).toBe(0);
    });

    it('returns empty Buffer when response.body is null', async () => {
      const response = new Response(null, { status: 204 });
      const buffer = await readBodyWithCap(response, SMALL_CAP);
      expect(buffer.length).toBe(0);
    });
  });
});
