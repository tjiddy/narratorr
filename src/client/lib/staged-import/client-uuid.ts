import { clientSubmissionIdSchema } from '@core/import-staging/schemas.js';

// randomUUID may be unavailable on plain-HTTP LAN origins; fall back to getRandomValues.
// Validate against the server schema and fail before create when secure entropy is unavailable.
export class EntropyUnavailableError extends Error {
  constructor() {
    super('Secure random values are unavailable in this browser — cannot start an import.');
    this.name = 'EntropyUnavailableError';
  }
}

const HEX: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function formatV4(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes);
  b[6] = (b[6]! & 0x0f) | 0x40; // Version 4.
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant.
  const h = Array.from(b, (byte) => HEX[byte]!);
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

export function generateClientSubmissionId(cryptoImpl: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined): string {
  let candidate: string;
  if (cryptoImpl && typeof cryptoImpl.randomUUID === 'function') {
    candidate = cryptoImpl.randomUUID();
  } else if (cryptoImpl && typeof cryptoImpl.getRandomValues === 'function') {
    candidate = formatV4(cryptoImpl.getRandomValues(new Uint8Array(16)));
  } else {
    throw new EntropyUnavailableError();
  }
  const parsed = clientSubmissionIdSchema.safeParse(candidate);
  if (!parsed.success) throw new EntropyUnavailableError();
  return parsed.data;
}
