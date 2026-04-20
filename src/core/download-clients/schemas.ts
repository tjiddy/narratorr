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
  dlspeed: z.number().optional(),
  save_path: z.string().default(''),
  content_path: z.string().optional(),
  added_on: z.number().default(0),
  completion_on: z.number().default(0),
}).passthrough();

export const qbTorrentsResponseSchema = z.array(qbTorrentSchema);

// Transmission RPC response schema
export const transmissionRpcResponseSchema = z.object({
  result: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

// NZBGet RPC response schema
// At least one of result or error must be present
export const nzbgetRpcResponseSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ name: z.string(), code: z.number(), message: z.string() }).optional(),
}).passthrough().refine(
  (data) => data.result !== undefined || data.error !== undefined,
  { message: 'NZBGet RPC response missing both "result" and "error" fields' },
);

// NZBGet group (active download) schema
// Non-critical fields default to 0/"" to tolerate partial responses
export const nzbgetGroupSchema = z.object({
  NZBID: z.number(),
  NZBName: z.string(),
  Status: z.string().default('UNKNOWN'),
  FileSizeMB: z.number().default(0),
  DownloadedSizeMB: z.number().default(0),
  RemainingSizeMB: z.number().default(0),
  DownloadTimeSec: z.number().default(0),
  Category: z.string().default(''),
  DestDir: z.string().default(''),
  MinPostTime: z.number().default(0),
}).passthrough();

// NZBGet history item schema
export const nzbgetHistorySchema = z.object({
  NZBID: z.number(),
  Name: z.string(),
  Status: z.string().default('UNKNOWN'),
  FileSizeMB: z.number().default(0),
  DownloadTimeSec: z.number().default(0),
  Category: z.string().default(''),
  DestDir: z.string().default(''),
  HistoryTime: z.number().default(0),
  MinPostTime: z.number().default(0),
  ParStatus: z.string().optional(),
  UnpackStatus: z.string().optional(),
  MoveStatus: z.string().optional(),
}).passthrough();
