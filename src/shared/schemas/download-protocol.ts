import { z } from 'zod';

// ============================================================================
// Download protocol — canonical source for the torrent/usenet enum.
// Derives the Zod enum, the TS union type, and the DB column's enum values
// from one `as const` tuple so they can never drift apart.
// ============================================================================

export const PROTOCOLS = ['torrent', 'usenet'] as const;
export const protocolSchema = z.enum(PROTOCOLS);
export type DownloadProtocol = (typeof PROTOCOLS)[number];
