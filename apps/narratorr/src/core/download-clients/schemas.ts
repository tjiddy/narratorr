import { z } from 'zod';

// qBittorrent torrent info response schema
// Non-critical fields default to 0/"" to tolerate partial responses
export const qbTorrentSchema = z.object({
  hash: z.string(),
  name: z.string(),
  state: z.string().default('unknown'),
  progress: z.number().default(0),
  total_size: z.number().default(0),
  downloaded: z.number().default(0),
  uploaded: z.number().default(0),
  ratio: z.number().default(0),
  num_seeds: z.number().default(0),
  num_leechs: z.number().default(0),
  eta: z.number().default(0),
  save_path: z.string().default(''),
  added_on: z.number().default(0),
  completion_on: z.number().default(0),
}).passthrough();

export const qbTorrentsResponseSchema = z.array(qbTorrentSchema);

// Transmission RPC response schema
export const transmissionRpcResponseSchema = z.object({
  result: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
