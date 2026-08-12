import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getKey } from '../utils/secret-codec.js';

const previewTokenPayloadSchema = z.object({
  purpose: z.literal('audio-preview'),
  path: z.string().min(1),
  scanRoot: z.string().min(1),
  exp: z.number().int().positive(),
});

export type PreviewTokenPayload = z.infer<typeof previewTokenPayloadSchema>;

// Four hours covers long import reviews; this token scopes a file but does not authenticate.
const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

/** Derive a purpose-specific signing key so preview tokens don't reuse the raw encryption key. */
function getSigningKey(): Buffer {
  return createHmac('sha256', getKey()).update('audio-preview-token-v1').digest();
}

function sign(data: string): string {
  return createHmac('sha256', getSigningKey()).update(data).digest('base64url');
}

export function mintPreviewToken(path: string, scanRoot: string): string {
  const payload: PreviewTokenPayload = {
    purpose: 'audio-preview',
    path,
    scanRoot,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyPreviewToken(token: string): PreviewTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  if (!body || !sig) return null;

  // Hash to equal lengths before timingSafeEqual; an early length check leaks timing.
  const expected = sign(body);
  const sigHash = createHash('sha256').update(sig).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  if (!timingSafeEqual(sigHash, expectedHash)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }

  const parsed = previewTokenPayloadSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.exp < Date.now()) return null;
  return parsed.data;
}
