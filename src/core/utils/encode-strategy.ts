import { extname } from 'node:path';
import { deriveFfprobePath } from './ffprobe-path.js';
// Imported by path, not via the core/utils barrel — the collector below reaches
// node:child_process through audio-probe, and the barrel feeds the Vite client build.
// Mirrors how audio-processor.ts imports sanitized-env.js.
import { getFFprobeStreamInfo } from './audio-probe.js';

/**
 * The lowest kbps value this module treats as real evidence or a real target.
 *
 * Sub-8 kbps numbers are not audiobook streams, they are the documented lie class: an MP3
 * whose Xing/Info header reports 827 bps floors to 0 kbps, its 1000–7999 bps neighbours to
 * 1–7. 8 kbps is also the lowest rate either target encoder can represent. This is the kbps
 * twin of `MIN_PLAUSIBLE_BITRATE_BPS` in audio-probe.ts, which guards a different decision
 * (implied-duration plausibility) and is deliberately given the same threshold.
 *
 * A rejected value is DISCARDED. Nothing is ever raised to this floor.
 */
export const MIN_PLAUSIBLE_SOURCE_BITRATE_KBPS = 8;

/** Ceiling for an AAC target — the operator-settable maximum in the processing settings schema. */
export const MAX_AAC_TARGET_KBPS = 512;

/**
 * Used only when no usable bitrate evidence exists at all. Above the common audiobook range
 * (32–128 kbps) so a wholly unknown source is not gratuitously downgraded, and deliberately
 * NOT the settings default of 128, so an emitted `-b:a 192k` proves the unused fallback value
 * never leaked into the keep-original path.
 */
export const KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS = 192;

/**
 * ITU-T / ISO 11172-3 Layer III bitrate tables, ascending. Transcribed data, not tuning
 * knobs — never edit a value to make a test pass.
 */
export const MP3_BITRATES_MPEG1: readonly number[] =
  [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
/** ISO 13818-3 / MPEG-2.5 Layer III table (the lower sample-rate generations). */
export const MP3_BITRATES_MPEG2: readonly number[] =
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/**
 * Every rate legal at EVERY MPEG sample rate. Derived from the two tables above at module
 * load so it cannot drift out of being a true intersection.
 */
export const MP3_BITRATES_RATE_AGNOSTIC: readonly number[] =
  MP3_BITRATES_MPEG1.filter((b) => MP3_BITRATES_MPEG2.includes(b));

const MPEG1_SAMPLE_RATES = new Set([32_000, 44_100, 48_000]);
const MPEG2_SAMPLE_RATES = new Set([8000, 11_025, 12_000, 16_000, 22_050, 24_000]);
const MP4_FAMILY_EXTENSIONS = new Set(['.m4b', '.m4a']);

/**
 * Why the two encoders are treated asymmetrically, since that is the first question the code
 * raises: FFmpeg's native `aac` encoder ACCEPTS any bitrate and normalizes internally (it
 * clamps to 6144 x channels bits per 1024-sample frame), so only the achieved rate is at
 * stake — and achieved rates are outside this module's guarantees. `libmp3lame` rejects or
 * silently re-rates an off-table or wrong-generation value, so the COMMAND itself is at
 * stake, which is why only MP3 gets a snap-to-table step.
 */

export type EncodeNoticeKind =
  /** AC11's min(resolved source, configured target) reduced the operator's number. */
  | 'evidence-cap'
  /** Snapped down to the highest legal MP3 rate at or below the request. */
  | 'mp3-table'
  /** Raised to the MP3 table minimum — the encoder has no legal rate below it. */
  | 'mp3-table-minimum'
  /** Capped at the operator-settable AAC maximum. */
  | 'aac-max'
  /** The book-level hint exceeded every usable probe and won the max. */
  | 'hint-overrode-probes'
  /** No usable evidence existed; the fallback started the chain. */
  | 'no-usable-evidence'
  /** A configured target was present but unusable, so it was treated as absent. */
  | 'unusable-target';

/**
 * One operator-visible fact about how the bitrate was decided.
 *
 * Chain steps (`evidence-cap`, `mp3-table`, `mp3-table-minimum`, `aac-max`) are recorded as
 * they are applied, so a step cannot exist without its notice and a notice cannot exist
 * without its step — and a step that moves nothing is not a step, which is why there is no
 * suppression rule. Every message describes what this module REQUESTED or EMITTED; none
 * claims what the encoder achieved.
 */
export interface EncodeNotice {
  kind: EncodeNoticeKind;
  /** The line delivered to ProcessingResult.warnings and onStderr. */
  message: string;
  /** Chain steps and `hint-overrode-probes` carry both operands; they are never equal. */
  from?: number;
  to?: number;
  /** `no-usable-evidence` only: the fallback value that started the chain. */
  bitrateKbps?: number;
  /** Present on a chain step whose chain started at the operator's configured target. */
  operatorTargetKbps?: number;
  /** `unusable-target` only: the rejected raw value, rendered safely (may be NaN/Infinity). */
  rejectedValue?: string;
  /** `unusable-target` only. */
  outcome?: 'treated-as-absent';
}

/** One source file's probe result, normalized to kbps at this boundary and nowhere else. */
export interface SourceEvidence {
  /** File extension including the dot; compared case-insensitively. */
  extension: string;
  /** ffprobe `codec_name`, lowercased. Absent when the probe returned null. */
  codec?: string | undefined;
  /** Source bitrate in **kbps** — floored from the probe's bps exactly once, in the collector. */
  bitrateKbps?: number | undefined;
  sampleRate?: number | undefined;
  channels?: number | undefined;
}

export interface EncodeStrategyInput {
  outputFormat: 'm4b' | 'mp3';
  /** `ProcessingConfig.bitrate` verbatim — kbps, raw and unvalidated. Never divided here. */
  targetBitrateKbps?: number | undefined;
  /** `ProcessingConfig.sourceBitrateKbps` verbatim — kbps, raw and unvalidated. */
  hintBitrateKbps?: number | undefined;
  /** Evidence for the sources feeding THIS one output command. */
  sources: SourceEvidence[];
}

export type EncodeStrategy =
  | { mode: 'copy'; notices: EncodeNotice[] }
  | { mode: 'encode'; codec: 'aac' | 'libmp3lame'; bitrateKbps: number; notices: EncodeNotice[] };

/**
 * The one validity predicate, applied to every numeric input in kbps: probe-derived values,
 * the book-level hint, and the configured target alike. Finite integer at or above the floor.
 */
export function isUsableBitrateKbps(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PLAUSIBLE_SOURCE_BITRATE_KBPS;
}

/**
 * Classify a configured target. Single-homed so the single-m4b short circuit and the resolver
 * agree on what "no usable target" means without either re-deriving the other's predicate.
 */
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
 * Copy eligibility: a pure remux is only safe when the whole set already matches the output
 * container's codec and agrees on stream layout. Any unprobeable, mixed-codec, mixed-container,
 * mixed-sample-rate or mixed-channel file disqualifies the WHOLE set. Raw ADTS `.aac` is never
 * eligible into m4b — that needs `-bsf:a aac_adtstoasc`, deliberately not implemented here.
 *
 * The rate/channel equality requirements are defense in depth, not a rescue: a set that fails
 * them is likely to fail in the concat demuxer whichever codec strategy is chosen, and falling
 * back to an explicit-bitrate re-encode is the loss-averse choice.
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

/**
 * Pick the Layer III table from the sample rate the WHOLE set agrees on. Rates that disagree,
 * any missing rate, or a rate in neither generation fall back to the intersection table, every
 * member of which is legal at every MPEG sample rate.
 */
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

/** Record one adjustment as it is applied and return its result. */
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

/** Move the requested target to a value the selected encoder accepts, disclosing every move. */
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
 * Resolve the codec strategy for ONE constructed ffmpeg command.
 *
 * Either a stream copy (no encoder token, no `-b:a`) or an encode carrying an explicit,
 * encoder-legal `-b:a` — ffmpeg's implicit default bitrate is unreachable from every path.
 * The emitted value is a REQUEST: the encoder may normalize it further, which this module
 * neither predicts nor observes.
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
  // Arithmetic, not prose: with no hint or no probe maximum there is no left or right operand,
  // so the predicate is false. A tie is false too — the request is the same either way, so the
  // result cannot depend on which origin an iteration order happened to tag.
  if (hint !== undefined && highestProbe !== undefined && hint > highestProbe) {
    notices.push({
      kind: 'hint-overrode-probes',
      from: hint,
      to: highestProbe,
      message: `Stored source bitrate ${hint} kbps exceeds every probed part (highest ${highestProbe} kbps) and was used as the request.`,
    });
  }

  // No precedence ladder: whichever value is higher wins. Over-estimating a source wastes
  // bytes; under-estimating destroys audio irreversibly.
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

/** The operator-visible lines for a resolved strategy, in chain order. */
export function noticeMessages(notices: EncodeNotice[]): string[] {
  return notices.map((n) => n.message);
}

/**
 * The codec arguments for one command. Exactly one of `-c:a copy` or
 * `-c:a <encoder> -b:a <n>k` — an encoder token is never emitted without a bitrate.
 */
export function buildCodecArgs(strategy: EncodeStrategy): string[] {
  return strategy.mode === 'copy'
    ? ['-c:a', 'copy']
    : ['-c:a', strategy.codec, '-b:a', `${strategy.bitrateKbps}k`];
}

/**
 * Probe every source for this command and normalize to the resolver's kbps evidence type.
 *
 * Reuses `getFFprobeStreamInfo` unchanged (sanitized env, 10 s timeout, graceful null). This
 * is the single place a probe's bps bitrate becomes kbps — nothing downstream divides again.
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

/** A one-line diagnostic naming the decision this module made (never what the encoder achieved). */
function describeStrategy(strategy: EncodeStrategy): string {
  return strategy.mode === 'copy'
    ? 'Encode strategy: stream copy (no re-encode).'
    : `Encode strategy: re-encode with ${strategy.codec} at a requested ${strategy.bitrateKbps} kbps.`;
}

/**
 * The seam both processor paths call, once per constructed command: probe, resolve, drain the
 * resolver's notices into the caller's accumulator (in command order), and return the codec
 * arguments. Callers never re-derive a resolver predicate to reconstruct a diagnostic.
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
