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

// Transmission torrent item — covers every field read by mapTorrent and mapStatus.
export const transmissionTorrentSchema = z.object({
  hashString: z.string(),
  name: z.string(),
  status: z.number(),
  percentDone: z.number(),
  totalSize: z.number(),
  downloadedEver: z.number(),
  uploadedEver: z.number(),
  uploadRatio: z.number(),
  peersSendingToUs: z.number(),
  peersGettingFromUs: z.number(),
  eta: z.number(),
  downloadDir: z.string(),
  addedDate: z.number(),
  doneDate: z.number(),
  errorString: z.string(),
  leftUntilDone: z.number(),
}).passthrough();

export const transmissionTorrentsArraySchema = z.array(transmissionTorrentSchema);

// SABnzbd queue/history response schemas — match only fields the code reads.
export const sabnzbdQueueSlotSchema = z.object({
  nzo_id: z.string(),
  filename: z.string(),
  status: z.string(),
  mb: z.string(),
  mbleft: z.string(),
  percentage: z.string(),
  timeleft: z.string(),
  kbpersec: z.string().optional(),
  cat: z.string(),
  storage: z.string().optional(),
}).passthrough();

export const sabnzbdQueueResponseSchema = z.object({
  queue: z.object({
    slots: z.array(sabnzbdQueueSlotSchema),
  }).passthrough(),
}).passthrough();

export const sabnzbdHistorySlotSchema = z.object({
  nzo_id: z.string(),
  name: z.string(),
  status: z.string(),
  bytes: z.number(),
  download_time: z.number(),
  completed: z.number(),
  category: z.string(),
  storage: z.string(),
  fail_message: z.string(),
}).passthrough();

export const sabnzbdHistoryResponseSchema = z.object({
  history: z.object({
    slots: z.array(sabnzbdHistorySlotSchema),
  }).passthrough(),
}).passthrough();

// Deluge RPC envelope. result/error semantics — at least one of them must
// be present, but result may legitimately be `null` (e.g. label.set_torrent
// returning success-with-no-payload). Use a refine instead of asserting both.
export const delugeRpcResponseSchema = z.object({
  id: z.number().optional(),
  result: z.unknown(),
  error: z.object({ message: z.string(), code: z.number() }).nullish(),
}).passthrough().refine(
  (data) => Object.prototype.hasOwnProperty.call(data, 'result') || data.error != null,
  { message: 'Deluge RPC response missing both "result" and "error" fields' },
);

// Deluge torrent-status — covers every field read by mapTorrent and mapState.
export const delugeTorrentStatusSchema = z.object({
  hash: z.string().optional(),
  name: z.string(),
  state: z.string(),
  progress: z.number(),
  total_size: z.number(),
  total_done: z.number(),
  total_uploaded: z.number(),
  ratio: z.number(),
  num_seeds: z.number(),
  num_peers: z.number(),
  eta: z.number(),
  download_rate: z.number().optional(),
  save_path: z.string(),
  time_added: z.number(),
  label: z.string().optional(),
  is_finished: z.boolean(),
}).passthrough();

export const delugeTorrentsStatusMapSchema = z.record(z.string(), delugeTorrentStatusSchema);

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
