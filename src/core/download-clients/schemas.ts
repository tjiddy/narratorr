import { z } from 'zod';

export const qbTorrentSchema = z.object({
  hash: z.string(),
  name: z.string(),
  // libtorrent 2.x re-keys `hash` to the truncated v2 hash for a hybrid torrent and moves the v1
  // here. Optional both ways: qBittorrent < 4.4 omits them, current builds emit "" for the missing
  // axis. Typed rather than left to .passthrough() so the identity matcher can read them.
  infohash_v1: z.string().nullish(),
  infohash_v2: z.string().nullish(),
  state: z.string().default('unknown'),
  progress: z.number().default(0),
  total_size: z.number().default(0),
  downloaded: z.number().default(0),
  uploaded: z.number().default(0),
  ratio: z.number().default(0),
  num_seeds: z.number().default(0),
  num_leechs: z.number().default(0),
  eta: z.number().default(0),
  dlspeed: z.number().nullish(),
  save_path: z.string().default(''),
  content_path: z.string().nullish(),
  added_on: z.number().default(0),
  completion_on: z.number().default(0),
}).passthrough();

export const qbTorrentsResponseSchema = z.array(qbTorrentSchema);

// Only category keys matter; tolerate loose inner metadata.
export const qbCategoriesResponseSchema = z.record(
  z.string(),
  z.object({
    name: z.string().nullish(),
    savePath: z.string().nullish(),
  }).passthrough(),
);

export const transmissionRpcResponseSchema = z.object({
  result: z.string(),
  arguments: z.record(z.string(), z.unknown()).nullish(),
}).passthrough();

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

export const transmissionSessionGetSchema = z.object({
  version: z.string().nullish(),
}).passthrough();

export const sabnzbdQueueSlotSchema = z.object({
  nzo_id: z.string(),
  filename: z.string(),
  status: z.string(),
  mb: z.string(),
  mbleft: z.string(),
  percentage: z.string(),
  timeleft: z.string(),
  kbpersec: z.string().nullish(),
  cat: z.string(),
  storage: z.string().nullish(),
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

export const sabnzbdVersionResponseSchema = z.object({
  version: z.string(),
}).passthrough();

export const sabnzbdAddResponseSchema = z.object({
  status: z.boolean(),
  nzo_ids: z.array(z.string()),
}).passthrough();

export const sabnzbdCategoriesResponseSchema = z.object({
  categories: z.array(z.string()),
}).passthrough();

// result may be null; presence of result or a non-null error makes the envelope valid.
export const delugeRpcResponseSchema = z.object({
  id: z.number().nullish(),
  result: z.unknown(),
  error: z.object({ message: z.string(), code: z.number() }).nullish(),
}).passthrough().refine(
  (data) => Object.prototype.hasOwnProperty.call(data, 'result') || data.error != null,
  { message: 'Deluge RPC response missing both "result" and "error" fields' },
);

export const delugeTorrentStatusSchema = z.object({
  hash: z.string().nullish(),
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
  download_rate: z.number().nullish(),
  save_path: z.string(),
  time_added: z.number(),
  label: z.string().nullish(),
  is_finished: z.boolean(),
}).passthrough();

export const delugeTorrentsStatusMapSchema = z.record(z.string(), delugeTorrentStatusSchema);

// NZBGet returns error:null on success; require result presence or a non-null error.
export const nzbgetRpcResponseSchema = z.object({
  result: z.unknown().nullish(),
  error: z.object({ name: z.string(), code: z.number(), message: z.string() }).nullish(),
}).passthrough().refine(
  (data) => data.result !== undefined || data.error != null,
  { message: 'NZBGet RPC response missing both "result" and "error" fields' },
);

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
  ParStatus: z.string().nullish(),
  UnpackStatus: z.string().nullish(),
  MoveStatus: z.string().nullish(),
  ScriptStatus: z.string().nullish(),
}).passthrough();
