import { extname } from 'node:path';
import { deriveFfprobePath } from './ffprobe-path.js';
// Import directly: audio-probe reaches Node APIs, while the barrel feeds the browser build.
import { getFFprobeStreamInfo } from './audio-probe.js';

/**
 * Reject, never clamp, values below 8 kbps: they include corrupt Xing/Info reports and neither
 * target encoder supports less. This mirrors audio-probe's bps plausibility floor.
 */
export const MIN_PLAUSIBLE_SOURCE_BITRATE_KBPS = 8;

/** Processing settings cap AAC requests at 512 kbps. */
export const MAX_AAC_TARGET_KBPS = 512;

/**
 * Used only without bitrate evidence. 192 avoids gratuitous loss and intentionally differs from
 * the 128 setting default so fallback leakage is test-visible.
 */
export const KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS = 192;

/** ITU-T/ISO MPEG-1 Layer III bitrate table; protocol data, not tuning. */
export const MP3_BITRATES_MPEG1: readonly number[] =
  [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** ISO MPEG-2/2.5 Layer III bitrate table. */
export const MP3_BITRATES_MPEG2: readonly number[] =
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** Rates legal for both MPEG generations, derived at load time to prevent drift. */
export const MP3_BITRATES_RATE_AGNOSTIC: readonly number[] =
  MP3_BITRATES_MPEG1.filter((b) => MP3_BITRATES_MPEG2.includes(b));

const MPEG1_SAMPLE_RATES = new Set([32_000, 44_100, 48_000]);
const MPEG2_SAMPLE_RATES = new Set([8000, 11_025, 12_000, 16_000, 22_050, 24_000]);
const MP4_FAMILY_EXTENSIONS = new Set(['.m4b', '.m4a']);

/**
 * FFmpeg AAC accepts arbitrary requests and normalizes internally; libmp3lame may reject or rerate
 * off-table values. Therefore only MP3 requests are snapped to a legal table.
 */

export type EncodeNoticeKind =
  | 'evidence-cap'
  | 'mp3-table'
  | 'mp3-table-minimum'
  | 'aac-max'
  | 'hint-overrode-probes'
  | 'no-usable-evidence'
  | 'unusable-target';

/**
 * Ordered, operator-visible explanation of each bitrate adjustment. Messages describe requested
 * or emitted values, never achieved encoder output.
 */
export interface EncodeNotice {
  kind: EncodeNoticeKind;
  /** Delivered to ProcessingResult.warnings and onStderr. */
  message: string;
  /** Adjustment operands for chain and hint-override notices; never equal. */
  from?: number;
  to?: number;
  /** Fallback that started a `no-usable-evidence` chain. */
  bitrateKbps?: number;
  /** Original configured target when it started the chain. */
  operatorTargetKbps?: number;
  /** Safely rendered rejected target, including NaN or Infinity. */
  rejectedValue?: string;
  outcome?: 'treated-as-absent';
}

/** One source probe, normalized to kbps only at this boundary. */
export interface SourceEvidence {
  /** File extension including the dot; compared case-insensitively. */
  extension: string;
  /** ffprobe `codec_name`, lowercased. Absent when the probe returned null. */
  codec?: string | undefined;
  /** Kbps, floored from probe bps exactly once in the collector. */
  bitrateKbps?: number | undefined;
  sampleRate?: number | undefined;
  channels?: number | undefined;
}

export interface EncodeStrategyInput {
  outputFormat: 'm4b' | 'mp3';
  /** Raw, unvalidated ProcessingConfig bitrate in kbps; never divided here. */
  targetBitrateKbps?: number | undefined;
  /** Raw, unvalidated ProcessingConfig source-bitrate hint in kbps. */
  hintBitrateKbps?: number | undefined;
  /** Evidence for sources feeding this one output command. */
  sources: SourceEvidence[];
}

export type EncodeStrategy =
  | { mode: 'copy'; notices: EncodeNotice[] }
  | { mode: 'encode'; codec: 'aac' | 'libmp3lame'; bitrateKbps: number; notices: EncodeNotice[] };

/** Shared validity predicate for probe values, book hints, and configured targets. */
export function isUsableBitrateKbps(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PLAUSIBLE_SOURCE_BITRATE_KBPS;
}

/** Single home for target validity so copy selection and legalization cannot disagree. */
export function resolveTargetBitrate(
  raw: number | undefined,
): { targetKbps?: number; notices: EncodeNotice[] } {
  if (isUsableBitrateKbps(raw)) return { targetKbps: raw, notices: [] };
  if (raw === undefined) return { notices: [] };
  return {
    notices: [{
      kind: 'unusable-target',
      rejectedValue: String(raw),
      outcome: 'treated-as-absent',
      message: `Configured target bitrate "${String(raw)}" is not a usable kbps value; treated as absent, keeping the original bitrate.`,
    }],
  };
}

/**
 * Copy requires every source to match output codec/container, sample rate, and channels. Raw ADTS
 * AAC is excluded because m4b needs `aac_adtstoasc`; missing or mixed evidence re-encodes.
 */
function isCopyEligible(outputFormat: 'm4b' | 'mp3', sources: SourceEvidence[]): boolean {
  const first = sources[0];
  if (first === undefined || first.sampleRate === undefined || first.channels === undefined) return false;
  return sources.every((s) => {
    if (s.codec === undefined || s.sampleRate !== first.sampleRate || s.channels !== first.channels) return false;
    const ext = s.extension.toLowerCase();
    return outputFormat === 'm4b'
      ? MP4_FAMILY_EXTENSIONS.has(ext) && s.codec === 'aac'
      : ext === '.mp3' && s.codec === 'mp3';
  });
}

/** Mixed, missing, or unknown sample rates use the intersection table legal for both generations. */
export function selectMp3Table(sources: SourceEvidence[]): readonly number[] {
  const rates = sources.map((s) => s.sampleRate);
  if (rates.length === 0 || rates.some((r) => r === undefined)) return MP3_BITRATES_RATE_AGNOSTIC;
  if (new Set(rates).size !== 1) return MP3_BITRATES_RATE_AGNOSTIC;
  const rate = rates[0]!;
  if (MPEG1_SAMPLE_RATES.has(rate)) return MP3_BITRATES_MPEG1;
  if (MPEG2_SAMPLE_RATES.has(rate)) return MP3_BITRATES_MPEG2;
  return MP3_BITRATES_RATE_AGNOSTIC;
}

const STEP_MESSAGES: Record<'evidence-cap' | 'mp3-table' | 'mp3-table-minimum' | 'aac-max', (from: number, to: number) => string> = {
  'evidence-cap': (from, to) =>
    `Requested bitrate reduced from ${from} kbps to ${to} kbps — that is the highest the source evidence supports (no upsampling).`,
  'mp3-table': (from, to) =>
    `Requested bitrate rounded down from ${from} kbps to ${to} kbps — the highest legal MP3 rate at or below it for this source.`,
  'mp3-table-minimum': (from, to) =>
    `Requested bitrate raised from ${from} kbps to ${to} kbps — MP3 has no legal rate below that for this source.`,
  'aac-max': (from, to) =>
    `Requested bitrate capped from ${from} kbps to ${to} kbps — the maximum this setting allows. The encoder may adjust it further.`,
};

function recordStep(
  notices: EncodeNotice[],
  kind: 'evidence-cap' | 'mp3-table' | 'mp3-table-minimum' | 'aac-max',
  from: number,
  to: number,
  operatorTargetKbps: number | undefined,
): number {
  notices.push({
    kind,
    from,
    to,
    message: STEP_MESSAGES[kind](from, to)
      + (operatorTargetKbps !== undefined ? ` (configured target: ${operatorTargetKbps} kbps)` : ''),
    ...(operatorTargetKbps !== undefined && { operatorTargetKbps }),
  });
  return to;
}

function legalize(
  codec: 'aac' | 'libmp3lame',
  requested: number,
  sources: SourceEvidence[],
  notices: EncodeNotice[],
  operatorTargetKbps: number | undefined,
): number {
  if (codec === 'aac') {
    return requested > MAX_AAC_TARGET_KBPS
      ? recordStep(notices, 'aac-max', requested, MAX_AAC_TARGET_KBPS, operatorTargetKbps)
      : requested;
  }
  const table = selectMp3Table(sources);
  const minimum = table[0]!;
  if (requested < minimum) {
    return recordStep(notices, 'mp3-table-minimum', requested, minimum, operatorTargetKbps);
  }
  const snapped = [...table].reverse().find((b) => b <= requested)!;
  return snapped === requested
    ? requested
    : recordStep(notices, 'mp3-table', requested, snapped, operatorTargetKbps);
}

/**
 * Resolves one ffmpeg command to copy or an encoder with an explicit legal bitrate; implicit ffmpeg
 * bitrate defaults are unreachable. The bitrate is requested, not guaranteed achieved.
 */
export function resolveEncodeStrategy(input: EncodeStrategyInput): EncodeStrategy {
  const { outputFormat, sources } = input;
  const { targetKbps, notices } = resolveTargetBitrate(input.targetBitrateKbps);

  // A usable explicit target always re-encodes, regardless of source codec.
  if (targetKbps === undefined && isCopyEligible(outputFormat, sources)) {
    return { mode: 'copy', notices };
  }

  const codec = outputFormat === 'm4b' ? 'aac' : 'libmp3lame';
  const probes = sources.map((s) => s.bitrateKbps).filter(isUsableBitrateKbps);
  const hint = isUsableBitrateKbps(input.hintBitrateKbps) ? input.hintBitrateKbps : undefined;
  const highestProbe = probes.length > 0 ? Math.max(...probes) : undefined;
  // With no hint or probe maximum the predicate is false; a tie is false so evidence order cannot change the notice.
  if (hint !== undefined && highestProbe !== undefined && hint > highestProbe) {
    notices.push({
      kind: 'hint-overrode-probes',
      from: hint,
      to: highestProbe,
      message: `Stored source bitrate ${hint} kbps exceeds every probed part (highest ${highestProbe} kbps) and was used as the request.`,
    });
  }

  // Use the highest evidence: overestimating wastes bytes; underestimating irreversibly loses audio.
  const evidence = hint === undefined ? probes : [...probes, hint];
  const resolvedSource = evidence.length > 0 ? Math.max(...evidence) : undefined;

  let requested: number;
  if (targetKbps !== undefined) {
    requested = resolvedSource !== undefined && resolvedSource < targetKbps
      ? recordStep(notices, 'evidence-cap', targetKbps, resolvedSource, targetKbps)
      : targetKbps;
  } else if (resolvedSource !== undefined) {
    requested = resolvedSource;
  } else {
    requested = KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS;
    notices.push({
      kind: 'no-usable-evidence',
      bitrateKbps: requested,
      message: `No usable source bitrate evidence — requesting the ${requested} kbps default.`,
    });
  }

  return {
    mode: 'encode',
    codec,
    bitrateKbps: legalize(codec, requested, sources, notices, targetKbps),
    notices,
  };
}

export function noticeMessages(notices: EncodeNotice[]): string[] {
  return notices.map((n) => n.message);
}

/** Emits either stream-copy args or an encoder with an explicit bitrate. */
export function buildCodecArgs(strategy: EncodeStrategy): string[] {
  return strategy.mode === 'copy'
    ? ['-c:a', 'copy']
    : ['-c:a', strategy.codec, '-b:a', `${strategy.bitrateKbps}k`];
}

/**
 * Probes every source and converts bitrate from bps to kbps exactly once here.
 * `getFFprobeStreamInfo` supplies sanitized env, timeout, and null-on-failure behavior.
 */
export async function collectSourceEvidence(
  ffmpegPath: string,
  filePaths: string[],
): Promise<SourceEvidence[]> {
  const ffprobePath = deriveFfprobePath(ffmpegPath);
  const evidence: SourceEvidence[] = [];
  for (const filePath of filePaths) {
    const info = await getFFprobeStreamInfo(ffprobePath, filePath);
    const source: SourceEvidence = { extension: extname(filePath).toLowerCase() };
    if (info) {
      source.codec = info.codec.toLowerCase();
      if (info.bitrate !== undefined) source.bitrateKbps = Math.floor(info.bitrate / 1000);
      if (info.sampleRate !== undefined) source.sampleRate = info.sampleRate;
      if (info.channels !== undefined) source.channels = info.channels;
    }
    evidence.push(source);
  }
  return evidence;
}

function describeStrategy(strategy: EncodeStrategy): string {
  return strategy.mode === 'copy'
    ? 'Encode strategy: stream copy (no re-encode).'
    : `Encode strategy: re-encode with ${strategy.codec} at a requested ${strategy.bitrateKbps} kbps.`;
}

/**
 * Per-command seam: probe, resolve, append notices in order, emit the decision diagnostic, and
 * return codec args. Callers must not rederive resolver predicates.
 */
export async function resolveCodecArgs(
  config: {
    ffmpegPath: string;
    outputFormat: 'm4b' | 'mp3';
    bitrate?: number | undefined;
    sourceBitrateKbps?: number | undefined;
  },
  filePaths: string[],
  warnings: string[],
  onStderr?: ((line: string) => void) | undefined,
): Promise<string[]> {
  const sources = await collectSourceEvidence(config.ffmpegPath, filePaths);
  const strategy = resolveEncodeStrategy({
    outputFormat: config.outputFormat,
    targetBitrateKbps: config.bitrate,
    hintBitrateKbps: config.sourceBitrateKbps,
    sources,
  });
  for (const message of noticeMessages(strategy.notices)) {
    warnings.push(message);
    onStderr?.(message);
  }
  onStderr?.(describeStrategy(strategy));
  return buildCodecArgs(strategy);
}
