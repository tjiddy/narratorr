import { extname } from 'node:path';
import type { TagMetadata } from './tagging.service.js';
import type { SIMPLE_EXCLUDABLE_FIELDS } from './retag-plan.js';

export type MutagenFormat = 'mp4' | 'id3';

/**
 * `text` is an MP4 text atom / an ID3 text frame, `freeform` an MP4 `----:` atom / an ID3 `TXXX`
 * frame, `int` an MP4 integer atom, `pair` the MP4 `trkn` tuple. `value` is always the canonical
 * string the writer expects to read back, so verification is a plain string comparison.
 */
export type MutagenOpKind = 'text' | 'freeform' | 'int' | 'pair';

export interface MutagenTagOp {
  key: string;
  kind: MutagenOpKind;
  value: string;
}

export interface MutagenRequest {
  path: string;
  format: MutagenFormat;
  ops: MutagenTagOp[];
  cover: { path: string; mime: string } | null;
}

type SimpleTagField = (typeof SIMPLE_EXCLUDABLE_FIELDS)[number];
type FieldMapping = readonly [SimpleTagField, string, MutagenOpKind];

/**
 * `©grp` is the only reason the series *name* used to survive an ffmpeg M4B retag: it is the one
 * freeform-ish key the mov muxer had an atom for. Everything else in the lower half of this table
 * evaporated silently, which is the defect #2210 exists to close.
 */
export const MP4_TAG_ATOMS: ReadonlyArray<FieldMapping> = [
  ['artist', '©ART', 'text'],
  ['albumArtist', 'aART', 'text'],
  ['album', '©alb', 'text'],
  ['title', '©nam', 'text'],
  ['composer', '©wrt', 'text'],
  ['grouping', '©grp', 'text'],
  ['genre', '©gen', 'text'],
  ['date', '©day', 'text'],
  ['description', 'desc', 'text'],
  ['subtitle', '----:com.apple.iTunes:SUBTITLE', 'freeform'],
  ['asin', '----:com.apple.iTunes:ASIN', 'freeform'],
  ['publisher', '----:com.apple.iTunes:PUBLISHER', 'freeform'],
  ['series', '----:com.apple.iTunes:SERIES', 'freeform'],
];

/** `TPUB` reads back as music-metadata's `common.label`, never `common.publisher` — see readNativeFreeform. */
export const ID3_TAG_FRAMES: ReadonlyArray<FieldMapping> = [
  ['artist', 'TPE1', 'text'],
  ['albumArtist', 'TPE2', 'text'],
  ['album', 'TALB', 'text'],
  ['title', 'TIT2', 'text'],
  ['composer', 'TCOM', 'text'],
  ['grouping', 'TIT1', 'text'],
  ['genre', 'TCON', 'text'],
  ['date', 'TDRC', 'text'],
  ['description', 'TDES', 'text'],
  ['subtitle', 'TIT3', 'text'],
  ['asin', 'TXXX:ASIN', 'freeform'],
  ['publisher', 'TPUB', 'text'],
  ['series', 'TXXX:series', 'freeform'],
];

const COVER_MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export function mutagenFormatForExtension(ext: string): MutagenFormat | null {
  if (ext === '.mp3') return 'id3';
  // mutagen's MP4 class handles .m4a identically to .m4b; no third branch is warranted.
  if (ext === '.m4a' || ext === '.m4b') return 'mp4';
  return null;
}

function pushSeriesOps(ops: MutagenTagOp[], format: MutagenFormat, tags: TagMetadata): void {
  // The movement atoms are the portability channel; the freeform pair is the round-trip channel.
  // Both are always written, so a fractional position survives and pre-mutagen files stay readable.
  if (tags.series) {
    ops.push({ key: format === 'mp4' ? '©mvn' : 'MVNM', kind: 'text', value: tags.series });
  }
  if (tags.seriesPart == null) return;
  const part = `${tags.seriesPart}`;
  if (format === 'mp4') {
    // `©mvi` is an integer atom — mutagen raises MP4MetadataValueError on a float, so 2.5 rides the
    // freeform channel alone. `©mvc` (series book count) is never written: the count is not on the
    // retag input and #2210 D3 forbids adding a lookup for it.
    if (Number.isInteger(tags.seriesPart)) ops.push({ key: '©mvi', kind: 'int', value: part });
    ops.push({ key: '----:com.apple.iTunes:SERIES-PART', kind: 'freeform', value: part });
  } else {
    // MVIN is a text frame, so the exact value is safe even when fractional.
    ops.push({ key: 'MVIN', kind: 'text', value: part });
    ops.push({ key: 'TXXX:series-part', kind: 'freeform', value: part });
  }
}

/**
 * Pure: no filesystem, no spawn. Truthy string checks and the `!= null` numeric checks reproduce
 * the pre-mutagen contract exactly, so the preview diff still predicts what the apply path writes.
 */
export function buildMutagenRequest(args: {
  filePath: string;
  format: MutagenFormat;
  tags: TagMetadata;
  coverPath?: string | undefined;
}): { request: MutagenRequest; warnings: string[] } {
  const { filePath, format, tags, coverPath } = args;
  const ops: MutagenTagOp[] = [];

  for (const [field, key, kind] of format === 'mp4' ? MP4_TAG_ATOMS : ID3_TAG_FRAMES) {
    const value = tags[field];
    if (value) ops.push({ key, kind, value });
  }

  pushSeriesOps(ops, format, tags);

  if (tags.track != null && tags.trackTotal != null) {
    const value = `${tags.track}/${tags.trackTotal}`;
    ops.push(format === 'mp4' ? { key: 'trkn', kind: 'pair', value } : { key: 'TRCK', kind: 'text', value });
  }

  const warnings: string[] = [];
  let cover: MutagenRequest['cover'] = null;
  if (coverPath) {
    const mime = COVER_MIME_BY_EXTENSION[extname(coverPath).toLowerCase()];
    // COVER_FILE_REGEX admits .webp but neither MP4Cover nor APIC has a format for it. Warn and
    // write the rest — the ffmpeg path used to fail the whole invocation, so this is strictly better.
    if (mime) cover = { path: coverPath, mime };
    else warnings.push(`Cover art format not supported for embedding: ${extname(coverPath)}`);
  }

  return { request: { path: filePath, format, ops, cover }, warnings };
}
