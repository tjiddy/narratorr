import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { collectAudioFilePaths } from '../../core/utils/collect-audio-files.js';

const AUDIO_MIME_MAP: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4b': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wma': 'audio/x-ms-wma',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
};

export function getAudioMimeType(ext: string): string {
  return AUDIO_MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * Parse an HTTP Range header. Returns `{ start: -1, end: -1 }` for any invalid
 * range — including non-finite numbers from failed parseInt — so callers map
 * to a 416 response without ever seeing NaN.
 */
export function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } {
  const match = /bytes=(-?\d*)-(\d*)/.exec(rangeHeader);
  if (!match) return { start: -1, end: -1 };

  const [, rawStart, rawEnd] = match as unknown as [string, string, string];

  // Suffix range: bytes=-500 (last 500 bytes)
  if (rawStart === '') {
    const suffixLen = parseInt(rawEnd, 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { start: -1, end: -1 };
    const start = Math.max(0, fileSize - suffixLen);
    return { start, end: fileSize - 1 };
  }

  // Negative start: bytes=-500
  if (rawStart.startsWith('-')) {
    const suffixLen = parseInt(rawStart.slice(1), 10);
    if (!Number.isFinite(suffixLen) || suffixLen <= 0) return { start: -1, end: -1 };
    const start = Math.max(0, fileSize - suffixLen);
    return { start, end: fileSize - 1 };
  }

  const start = parseInt(rawStart, 10);
  const end = rawEnd === '' ? fileSize - 1 : parseInt(rawEnd, 10);

  if (!Number.isFinite(start) || !Number.isFinite(end)) return { start: -1, end: -1 };
  if (start < 0 || start >= fileSize || end < start) return { start: -1, end: -1 };

  return { start, end: Math.min(end, fileSize - 1) };
}

/**
 * Resolve a path to a single audio file. Supports both file targets (returns
 * directly if audio extension) and directory targets (recursive search).
 *
 * Disc-folder ordering: uses `collectAudioFilePaths` (unsorted) and applies a
 * path-aware locale-numeric sort. The shared helper's `sort: 'locale-numeric'`
 * mode sorts by basename only, which TIES on `Disc 1/track1.mp3` vs
 * `Disc 2/track1.mp3` (both basenames are `track1.mp3`). Path-aware sort is
 * required for deterministic ordering across discs.
 */
export async function resolvePreviewAudioFile(inputPath: string): Promise<string | null> {
  let s;
  try {
    s = await stat(inputPath);
  } catch {
    return null;
  }
  if (s.isFile()) {
    return AUDIO_EXTENSIONS.has(extname(inputPath).toLowerCase()) ? inputPath : null;
  }
  if (s.isDirectory()) {
    let files: string[];
    try {
      files = await collectAudioFilePaths(inputPath, { recursive: true, skipHidden: true });
    } catch {
      return null;
    }
    if (files.length === 0) return null;
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    return files[0]!;
  }
  return null;
}

/**
 * Stream an audio file with HTTP range support. Always sets `Cache-Control: no-store`
 * so per-row tokenized previews are not cached across token rotations.
 */
export async function streamAudioFile(
  filePath: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  let fileSize: number;
  try {
    const fileStat = await stat(filePath);
    fileSize = fileStat.size;
  } catch {
    request.log.warn({ path: filePath }, 'Audio file not accessible for preview');
    return reply.status(404).send({ error: 'Audio file not found' });
  }

  const mime = getAudioMimeType(extname(filePath).toLowerCase());
  const rangeHeader = request.headers.range;

  if (!rangeHeader || rangeHeader.includes(',')) {
    const stream = createReadStream(filePath);
    return reply
      .status(200)
      .header('Content-Type', mime)
      .header('Content-Length', fileSize)
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'no-store')
      .send(stream);
  }

  const { start, end } = parseRangeHeader(rangeHeader, fileSize);
  if (start === -1) {
    return reply
      .status(416)
      .header('Content-Range', `bytes */${fileSize}`)
      .header('Cache-Control', 'no-store')
      .send();
  }

  const contentLength = end - start + 1;
  const stream = createReadStream(filePath, { start, end });
  return reply
    .status(206)
    .header('Content-Type', mime)
    .header('Content-Length', contentLength)
    .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'no-store')
    .send(stream);
}
