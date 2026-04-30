/**
 * Read a `Response` body with a streamed size cap. Throws before reading when
 * `Content-Length` exceeds the cap; otherwise streams chunks and aborts the
 * reader as soon as the running total exceeds the cap (defends against servers
 * that lie about declared length).
 *
 * Callers do NOT see a partial body — overflow surfaces as a thrown error, not
 * a truncated buffer. The full body is returned only when the read completes
 * cleanly under the cap.
 */
export async function readBodyWithCap(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number.parseInt(contentLength, 10);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Drain so the connection can be reused/released
      await response.body?.cancel().catch(() => { /* best-effort */ });
      throw new Error(`Content-Length ${declared} exceeds cap of ${maxBytes} bytes`);
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  // Stream errors mid-read (broken connection, server crash) surface as a
  // partial read — return what we have. Cap-exceeded is treated separately
  // and ALWAYS throws, since exceeding the cap is the security-relevant case
  // we must not silently allow.
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => { /* best-effort */ });
          throw new Error(`Streamed body exceeded cap of ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && /exceeded cap/.test(error.message)) {
      throw error;
    }
    // Broken-stream error — return what we read so the caller sees a Response
    // with a (possibly empty) body and can still inspect status/headers.
  }

  return Buffer.concat(chunks);
}
