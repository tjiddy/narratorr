import { z } from 'zod';

export const PROTOCOLS = ['torrent', 'usenet'] as const;
export const protocolSchema = z.enum(PROTOCOLS);
export type DownloadProtocol = (typeof PROTOCOLS)[number];
