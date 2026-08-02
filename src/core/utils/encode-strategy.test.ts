import { describe, it, expect } from 'vitest';
import {
  resolveEncodeStrategy,
  resolveTargetBitrate,
  buildCodecArgs,
  selectMp3Table,
  isUsableBitrateKbps,
  MIN_PLAUSIBLE_SOURCE_BITRATE_KBPS,
  MAX_AAC_TARGET_KBPS,
  KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS,
  MP3_BITRATES_MPEG1,
  MP3_BITRATES_MPEG2,
  MP3_BITRATES_RATE_AGNOSTIC,
  type SourceEvidence,
  type EncodeStrategy,
  type EncodeStrategyInput,
} from './encode-strategy.js';

/** A fully-probed, copy-eligible AAC/m4b source. Override one field per rejection case. */
function aacSource(overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  return { extension: '.m4b', codec: 'aac', bitrateKbps: 128, sampleRate: 44_100, channels: 2, ...overrides };
}

/** A fully-probed, copy-eligible MP3 source. */
function mp3Source(overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  return { extension: '.mp3', codec: 'mp3', bitrateKbps: 128, sampleRate: 44_100, channels: 2, ...overrides };
}

function resolve(input: Partial<EncodeStrategyInput> & { sources: SourceEvidence[] }): EncodeStrategy {
  return resolveEncodeStrategy({ outputFormat: 'm4b', ...input });
}

function encodeOf(strategy: EncodeStrategy): Extract<EncodeStrategy, { mode: 'encode' }> {
  if (strategy.mode !== 'encode') throw new Error(`expected an encode strategy, got ${strategy.mode}`);
  return strategy;
}

function kinds(strategy: EncodeStrategy): string[] {
  return strategy.notices.map((n) => n.kind);
}

describe('resolveEncodeStrategy — stream-copy selection (AC1, AC2)', () => {
  it('copies a homogeneous .m4b / aac set into m4b', () => {
    const strategy = resolve({ sources: [aacSource(), aacSource(), aacSource()] });
    expect(strategy.mode).toBe('copy');
    expect(buildCodecArgs(strategy)).toEqual(['-c:a', 'copy']);
    expect(buildCodecArgs(strategy)).not.toContain('-b:a');
    expect(buildCodecArgs(strategy)).not.toContain('aac');
  });

  it('copies a homogeneous .m4a / aac set into m4b', () => {
    const sources = [aacSource({ extension: '.m4a' }), aacSource({ extension: '.m4a' }), aacSource({ extension: '.m4a' })];
    expect(resolve({ sources }).mode).toBe('copy');
  });

  it('copies a mixed .m4a + .m4b AAC set into m4b (both MP4-family)', () => {
    const sources = [aacSource({ extension: '.m4a' }), aacSource({ extension: '.m4b' })];
    expect(resolve({ sources }).mode).toBe('copy');
  });

  it('copies a homogeneous .mp3 / mp3 set into mp3', () => {
    const strategy = resolve({ outputFormat: 'mp3', sources: [mp3Source(), mp3Source(), mp3Source()] });
    expect(strategy.mode).toBe('copy');
  });

  it('compares extensions case-insensitively', () => {
    const sources = [aacSource({ extension: '.M4B' }), aacSource({ extension: '.M4A' })];
    expect(resolve({ sources }).mode).toBe('copy');
  });

  it.each<[string, Partial<EncodeStrategyInput>]>([
    ['mixed codec (aac + mp3)', { sources: [aacSource(), aacSource({ codec: 'mp3' })] }],
    ['mixed sample rate', { sources: [aacSource(), aacSource({ sampleRate: 22_050 })] }],
    ['mixed channel count', { sources: [aacSource(), aacSource({ channels: 1 })] }],
    ['absent sample rate', { sources: [aacSource({ sampleRate: undefined }), aacSource()] }],
    ['absent channel count', { sources: [aacSource({ channels: undefined }), aacSource()] }],
    ['one probe returned null', { sources: [aacSource(), { extension: '.m4b' }] }],
    ['raw ADTS .aac source into m4b', { sources: [aacSource({ extension: '.aac' })] }],
    ['aac source into mp3 output', { outputFormat: 'mp3', sources: [aacSource()] }],
    ['.m4a/aac source into mp3 output', { outputFormat: 'mp3', sources: [aacSource({ extension: '.m4a' })] }],
    ['empty source set', { sources: [] }],
  ])('rejects the copy path: %s', (_label, input) => {
    const strategy = resolveEncodeStrategy({ outputFormat: 'm4b', sources: [], ...input });
    expect(strategy.mode).toBe('encode');
  });

  it('never copies when a usable explicit target is configured, even for a homogeneous AAC set', () => {
    const strategy = resolve({ targetBitrateKbps: 128, sources: [aacSource(), aacSource()] });
    expect(encodeOf(strategy).bitrateKbps).toBe(128);
  });
});

describe('resolveEncodeStrategy — explicit target (AC11)', () => {
  it('caps the target at the resolved source (min)', () => {
    const strategy = resolve({ targetBitrateKbps: 128, hintBitrateKbps: 64, sources: [{ extension: '.mp3' }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(64);
  });

  it('keeps the target at the equal-value boundary and records no step', () => {
    const strategy = resolve({ targetBitrateKbps: 128, hintBitrateKbps: 128, sources: [{ extension: '.mp3' }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(128);
    expect(kinds(strategy)).toEqual([]);
  });

  it('uses the target as-is when no evidence exists', () => {
    const strategy = resolve({ targetBitrateKbps: 128, sources: [{ extension: '.mp3' }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(128);
    expect(kinds(strategy)).toEqual([]);
  });
});

describe('AC6 — one unit, one validity predicate', () => {
  it('resolves a 251000 bps probe and a 251 kbps hint to the same 251 (never divided twice)', () => {
    // The resolver's input is probe-collector output: a bps value is floored to kbps exactly
    // once, before it reaches here. Both spellings of "251" must land on the same request.
    const fromProbe = resolve({ outputFormat: 'mp3', sources: [{ extension: '.wav', bitrateKbps: Math.floor(251_000 / 1000) }] });
    const fromHint = resolve({ outputFormat: 'mp3', hintBitrateKbps: 251, sources: [{ extension: '.wav' }] });
    expect(encodeOf(fromProbe).bitrateKbps).toBe(encodeOf(fromHint).bitrateKbps);
    // 251 legalized against the rate-agnostic MP3 table (no sample rate known) → 160.
    expect(encodeOf(fromProbe).notices.find((n) => n.kind === 'mp3-table')?.from).toBe(251);
  });

  const USABILITY: Array<[unknown, boolean]> = [
    [0, false], [1, false], [7, false], [8, true], [9, true],
    [-1, false], [Number.NaN, false], [Number.POSITIVE_INFINITY, false], [128.5, false],
    [1411, true], [5000, true],
  ];

  it.each(USABILITY)('isUsableBitrateKbps(%s) === %s', (value, expected) => {
    expect(isUsableBitrateKbps(value as number)).toBe(expected);
  });

  it.each(USABILITY)('applies the same predicate to a probe value (%s → usable %s)', (value, expected) => {
    const strategy = resolve({ sources: [{ extension: '.wav', bitrateKbps: value as number }] });
    // Unusable → the AC9 fallback; usable → the value itself (AAC never snaps below 512).
    const expectedKbps = expected ? Math.min(value as number, MAX_AAC_TARGET_KBPS) : KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS;
    expect(encodeOf(strategy).bitrateKbps).toBe(expectedKbps);
  });

  it.each(USABILITY)('applies the same predicate to sourceBitrateKbps (%s → usable %s)', (value, expected) => {
    const strategy = resolve({ hintBitrateKbps: value as number, sources: [{ extension: '.wav' }] });
    const expectedKbps = expected ? Math.min(value as number, MAX_AAC_TARGET_KBPS) : KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS;
    expect(encodeOf(strategy).bitrateKbps).toBe(expectedKbps);
  });

  it('discards a rejected value rather than raising it to the floor', () => {
    const strategy = resolve({ sources: [{ extension: '.mp3', bitrateKbps: 7 }] });
    expect(encodeOf(strategy).bitrateKbps).not.toBe(MIN_PLAUSIBLE_SOURCE_BITRATE_KBPS);
    expect(kinds(strategy)).toContain('no-usable-evidence');
  });

  it.each([[Number.NaN], [0], [-1], [7], [128.5]])(
    'treats an unusable config.bitrate (%s) as absent, with an unusable-target notice',
    (bitrate) => {
      const strategy = resolve({ targetBitrateKbps: bitrate, sources: [{ extension: '.mp3' }] });
      const encode = encodeOf(strategy);
      // No evidence either → the AC9 fallback, never `-b:a NaNk` / `0k` / `7k`.
      expect(encode.bitrateKbps).toBe(KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS);
      expect(buildCodecArgs(strategy)).toContain(`${KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS}k`);
      const notice = strategy.notices.find((n) => n.kind === 'unusable-target');
      expect(notice).toBeDefined();
      expect(notice!.rejectedValue).toBe(String(bitrate));
      expect(notice!.outcome).toBe('treated-as-absent');
      expect(notice).not.toHaveProperty('bitrateKbps');
      expect(notice!.message).not.toMatch(/\dk\b/);
    },
  );

  it('lets an unusable config.bitrate fall through to the copy path, carrying its notice', () => {
    const strategy = resolve({ targetBitrateKbps: Number.NaN, sources: [aacSource(), aacSource()] });
    expect(strategy.mode).toBe('copy');
    expect(kinds(strategy)).toEqual(['unusable-target']);
  });
});

describe('AC7 — requested source bitrate is the max over all usable evidence', () => {
  it('takes the highest probe when the probes win', () => {
    const sources = [
      { extension: '.mp3', bitrateKbps: 128 },
      { extension: '.mp3', bitrateKbps: 251 },
      { extension: '.mp3', bitrateKbps: 192 },
    ];
    const strategy = resolve({ hintBitrateKbps: 96, sources });
    expect(encodeOf(strategy).bitrateKbps).toBe(251);
    expect(kinds(strategy)).not.toContain('hint-overrode-probes');
  });

  it('takes the hint when the hint wins, and discloses it', () => {
    const strategy = resolve({ hintBitrateKbps: 251, sources: [{ extension: '.mp3', bitrateKbps: 64 }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(251);
    const notice = strategy.notices.find((n) => n.kind === 'hint-overrode-probes');
    expect(notice).toMatchObject({ from: 251, to: 64 });
  });

  it('uses a partial probe success rather than dropping to the one probed value', () => {
    const sources = [{ extension: '.mp3', bitrateKbps: 64 }, { extension: '.mp3' }];
    expect(encodeOf(resolve({ hintBitrateKbps: 251, sources })).bitrateKbps).toBe(251);
  });

  it('falls back to the hint when every probe is invalid', () => {
    const sources = [{ extension: '.mp3', bitrateKbps: 0 }, { extension: '.mp3', bitrateKbps: 827 / 1000 }];
    expect(encodeOf(resolve({ hintBitrateKbps: 251, sources })).bitrateKbps).toBe(251);
  });

  it('rejects a garbage 827-bps probe without letting it become or drag down the max', () => {
    const sources = [
      { extension: '.mp3', bitrateKbps: Math.floor(827 / 1000) },
      { extension: '.mp3', bitrateKbps: 128 },
    ];
    const strategy = resolve({ sources });
    expect(encodeOf(strategy).bitrateKbps).toBe(128);
  });

  it('uses the AC9 fallback with a notice when the evidence set is empty', () => {
    const strategy = resolve({ sources: [{ extension: '.mp3' }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS);
    expect(strategy.notices.find((n) => n.kind === 'no-usable-evidence')?.bitrateKbps).toBe(192);
  });

  it('is a request, not a promise: complete low probes lose to a higher stale hint', () => {
    const sources = [64, 64, 64].map((bitrateKbps) => ({ extension: '.mp3', bitrateKbps }));
    const strategy = resolve({ hintBitrateKbps: 251, sources });
    expect(encodeOf(strategy).bitrateKbps).toBe(251);
    expect(strategy.notices.find((n) => n.kind === 'hint-overrode-probes')).toMatchObject({ from: 251, to: 64 });
  });

  it('resolves merge evidence jointly and convert evidence per file', () => {
    const low = { extension: '.mp3', bitrateKbps: 64 };
    const high = { extension: '.mp3', bitrateKbps: 251 };
    expect(encodeOf(resolve({ sources: [low, high] })).bitrateKbps).toBe(251);
    expect(encodeOf(resolve({ sources: [low] })).bitrateKbps).toBe(64);
    expect(encodeOf(resolve({ sources: [high] })).bitrateKbps).toBe(251);
  });

  it.each([[8, 8], [24, 24], [31, 31]])(
    'never raises a requested %s kbps on the AAC path',
    (requested, expected) => {
      expect(encodeOf(resolve({ hintBitrateKbps: requested, sources: [{ extension: '.mp3' }] })).bitrateKbps).toBe(expected);
    },
  );

  it('min(8, 128) stays 8 on the explicit AAC path', () => {
    const strategy = resolve({ targetBitrateKbps: 128, hintBitrateKbps: 8, sources: [{ extension: '.mp3' }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(8);
  });

  it('a 7 kbps candidate is absent from the evidence set, not raised to 8', () => {
    const strategy = resolve({ hintBitrateKbps: 7, sources: [{ extension: '.mp3' }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(KEEP_ORIGINAL_FALLBACK_BITRATE_KBPS);
  });
});

describe('hint-overrode-probes — the arithmetic predicate boundary', () => {
  it('fires with operands 251 → 64 when the hint beats the only probe', () => {
    const strategy = resolve({ hintBitrateKbps: 251, sources: [{ extension: '.mp3', bitrateKbps: 64 }] });
    expect(strategy.notices.find((n) => n.kind === 'hint-overrode-probes')).toMatchObject({ from: 251, to: 64 });
  });

  it.each([
    [[251, 64]],
    [[64, 251]],
  ])('does not fire on a tie, in evidence order %j', (probes) => {
    const sources = probes.map((bitrateKbps) => ({ extension: '.mp3', bitrateKbps }));
    const strategy = resolve({ hintBitrateKbps: 251, sources });
    expect(encodeOf(strategy).bitrateKbps).toBe(251);
    expect(kinds(strategy)).not.toContain('hint-overrode-probes');
  });

  it('does not fire when every probe is invalid (no probe maximum exists)', () => {
    const strategy = resolve({ hintBitrateKbps: 251, sources: [{ extension: '.mp3', bitrateKbps: 0 }] });
    expect(encodeOf(strategy).bitrateKbps).toBe(251);
    expect(kinds(strategy)).not.toContain('hint-overrode-probes');
  });

  it('does not fire when the hint lost', () => {
    const sources = [128, 251, 192].map((bitrateKbps) => ({ extension: '.mp3', bitrateKbps }));
    expect(kinds(resolve({ hintBitrateKbps: 96, sources }))).not.toContain('hint-overrode-probes');
  });

  it('never emits a notice with equal operands', () => {
    const inputs: EncodeStrategyInput[] = [];
    for (const hint of [undefined, 8, 64, 128, 251]) {
      for (const probe of [undefined, 8, 64, 128, 251]) {
        for (const outputFormat of ['m4b', 'mp3'] as const) {
          inputs.push({
            outputFormat,
            ...(hint !== undefined && { hintBitrateKbps: hint }),
            sources: [{ extension: '.mp3', ...(probe !== undefined && { bitrateKbps: probe }) }],
          });
        }
      }
    }
    for (const input of inputs) {
      for (const notice of resolveEncodeStrategy(input).notices) {
        if (notice.from !== undefined) expect(notice.from).not.toBe(notice.to);
      }
    }
  });
});

describe('AC8 — AAC legalization', () => {
  it.each([[700, 512], [512, 512], [513, 512], [192, 192]])(
    'requested %s → %s',
    (requested, expected) => {
      const strategy = resolve({ hintBitrateKbps: requested, sources: [{ extension: '.mp3' }] });
      expect(encodeOf(strategy).bitrateKbps).toBe(expected);
    },
  );

  it('does not model the 6144 x channels frame clamp: a mono 44.1 kHz source still requests 512', () => {
    const sources = [{ extension: '.wav', bitrateKbps: 512, sampleRate: 44_100, channels: 1 }];
    const strategy = resolve({ sources });
    expect(encodeOf(strategy).bitrateKbps).toBe(MAX_AAC_TARGET_KBPS);
    expect(kinds(strategy)).toEqual([]);
  });

  it('reports the aac-max step as a requested value, never an achieved one', () => {
    const sources = [{ extension: '.wav', bitrateKbps: 705, sampleRate: 44_100, channels: 1 }];
    const notice = resolve({ sources }).notices.find((n) => n.kind === 'aac-max');
    expect(notice).toMatchObject({ from: 705, to: 512 });
    expect(notice!.message).toMatch(/requested/i);
    expect(notice!.message).not.toMatch(/achiev/i);
  });
});

describe('AC8 — MP3 table selection by set-wide sample-rate agreement', () => {
  function mp3At(rate: number | undefined, bitrateKbps: number): SourceEvidence {
    return { extension: '.mp3', bitrateKbps, ...(rate !== undefined && { sampleRate: rate }) };
  }

  function requestMp3(requested: number, rates: Array<number | undefined>): EncodeStrategy {
    // Drive the request through the hint so the sources only carry the rate dimension.
    return resolveEncodeStrategy({
      outputFormat: 'mp3',
      hintBitrateKbps: requested,
      sources: rates.map((r) => mp3At(r, 8)),
    });
  }

  it.each([[700, 320], [320, 320], [200, 192], [130, 128], [33, 32]])(
    'MPEG-1 arm (all 44.1 kHz): %s → %s',
    (requested, expected) => {
      const strategy = requestMp3(requested, [44_100, 44_100]);
      expect(encodeOf(strategy).bitrateKbps).toBe(expected);
      expect(MP3_BITRATES_MPEG1).toContain(encodeOf(strategy).bitrateKbps);
    },
  );

  it('MPEG-1 arm: a requested 8 is raised to the table minimum of 32 as a single step', () => {
    const strategy = resolveEncodeStrategy({
      outputFormat: 'mp3',
      targetBitrateKbps: 8,
      sources: [mp3At(44_100, 8)],
    });
    expect(encodeOf(strategy).bitrateKbps).toBe(32);
    expect(kinds(strategy)).toEqual(['mp3-table-minimum']);
    expect(strategy.notices[0]).toMatchObject({ from: 8, to: 32, operatorTargetKbps: 8 });
  });

  it.each([[700, 160], [200, 160], [24, 24], [8, 8]])(
    'MPEG-2 arm (all 22.05 kHz): %s → %s',
    (requested, expected) => {
      const strategy = requestMp3(requested, [22_050, 22_050]);
      expect(encodeOf(strategy).bitrateKbps).toBe(expected);
      expect(MP3_BITRATES_MPEG2).toContain(encodeOf(strategy).bitrateKbps);
    },
  );

  it.each<[string, Array<number | undefined>]>([
    ['mixed 44.1 + 22.05 kHz', [44_100, 22_050]],
    ['partially missing', [44_100, undefined]],
    ['all missing', [undefined, undefined]],
    ['non-MPEG rate', [11_024, 11_024]],
  ])('rate-agnostic arm (%s): 200 → 160', (_label, rates) => {
    const strategy = requestMp3(200, rates);
    expect(encodeOf(strategy).bitrateKbps).toBe(160);
    expect(MP3_BITRATES_RATE_AGNOSTIC).toContain(encodeOf(strategy).bitrateKbps);
  });

  it('MP3_BITRATES_RATE_AGNOSTIC really is the intersection of the two generation tables', () => {
    const intersection = MP3_BITRATES_MPEG1.filter((b) => MP3_BITRATES_MPEG2.includes(b));
    expect([...MP3_BITRATES_RATE_AGNOSTIC]).toEqual(intersection);
    for (const rate of MP3_BITRATES_RATE_AGNOSTIC) {
      expect(MP3_BITRATES_MPEG1).toContain(rate);
      expect(MP3_BITRATES_MPEG2).toContain(rate);
    }
  });

  it('selects the table from the set, not from one member', () => {
    expect(selectMp3Table([mp3At(48_000, 8), mp3At(32_000, 8)])).toBe(MP3_BITRATES_RATE_AGNOSTIC);
    expect(selectMp3Table([mp3At(48_000, 8)])).toBe(MP3_BITRATES_MPEG1);
    expect(selectMp3Table([mp3At(24_000, 8)])).toBe(MP3_BITRATES_MPEG2);
    expect(selectMp3Table([])).toBe(MP3_BITRATES_RATE_AGNOSTIC);
  });
});

describe('AC14 — notices are derived from the chain', () => {
  it('reports the AC9 fallback and its later legalization as two ordered notices', () => {
    const strategy = resolveEncodeStrategy({ outputFormat: 'mp3', sources: [{ extension: '.mp3' }] });
    expect(kinds(strategy)).toEqual(['no-usable-evidence', 'mp3-table']);
    expect(strategy.notices[0]).toMatchObject({ bitrateKbps: 192 });
    expect(strategy.notices[1]).toMatchObject({ from: 192, to: 160 });
    expect(encodeOf(strategy).bitrateKbps).toBe(160);
  });

  it('records an evidence-cap step only when the source is lower than the target', () => {
    const capped = resolve({ targetBitrateKbps: 128, hintBitrateKbps: 64, sources: [{ extension: '.mp3' }] });
    expect(capped.notices).toHaveLength(1);
    expect(capped.notices[0]).toMatchObject({ kind: 'evidence-cap', from: 128, to: 64, operatorTargetKbps: 128 });

    const unmoved = resolve({ targetBitrateKbps: 128, hintBitrateKbps: 251, sources: [{ extension: '.mp3' }] });
    expect(unmoved.notices).toEqual([]);
  });

  it('carries a notice on the AC13-shaped no-op input (copy decision, unusable target)', () => {
    const strategy = resolve({ targetBitrateKbps: 0, sources: [aacSource(), aacSource()] });
    expect(strategy.mode).toBe('copy');
    expect(kinds(strategy)).toEqual(['unusable-target']);
  });

  it('resolveTargetBitrate single-homes the usable/unusable decision', () => {
    expect(resolveTargetBitrate(undefined)).toEqual({ notices: [] });
    expect(resolveTargetBitrate(128)).toEqual({ targetKbps: 128, notices: [] });
    const unusable = resolveTargetBitrate(7);
    expect(unusable.targetKbps).toBeUndefined();
    expect(unusable.notices.map((n) => n.kind)).toEqual(['unusable-target']);
  });

  it('never claims what the encoder achieved', () => {
    const strategy = resolveEncodeStrategy({
      outputFormat: 'mp3',
      targetBitrateKbps: 512,
      sources: [{ extension: '.wav', bitrateKbps: 1411, sampleRate: 44_100, channels: 2 }],
    });
    for (const notice of strategy.notices) {
      expect(notice.message).not.toMatch(/achiev|deliver|actual/i);
    }
  });
});

describe('AC5/AC8 — exhaustive matrix invariant', () => {
  const OUTPUT_FORMATS = ['m4b', 'mp3'] as const;
  const TARGETS = [undefined, 128, Number.NaN];
  const HINTS = [undefined, 251, 0];
  const PROBE_SETS: Array<Array<number | undefined>> = [[128, 251], [128, undefined], [undefined, undefined]];
  const RATE_SETS: Array<Array<number | undefined>> = [
    [44_100, 44_100], [22_050, 22_050], [44_100, 22_050], [44_100, undefined], [undefined, undefined], [11_024, 11_024],
  ];
  const CHANNEL_SETS = [1, 2, 6, 9, undefined];
  const EXTENSIONS = ['.m4b', '.mp3'];

  it('always yields either a copy or a legal, fully-specified encode — and never shapes the output', () => {
    let cases = 0;
    for (const outputFormat of OUTPUT_FORMATS) {
      for (const targetBitrateKbps of TARGETS) {
        for (const hintBitrateKbps of HINTS) {
          for (const probes of PROBE_SETS) {
            for (const rates of RATE_SETS) {
              for (const channels of CHANNEL_SETS) {
                for (const extension of EXTENSIONS) {
                  const sources: SourceEvidence[] = probes.map((bitrateKbps, i) => ({
                    extension,
                    codec: extension === '.mp3' ? 'mp3' : 'aac',
                    ...(bitrateKbps !== undefined && { bitrateKbps }),
                    ...(rates[i] !== undefined && { sampleRate: rates[i] }),
                    ...(channels !== undefined && { channels }),
                  }));
                  const strategy = resolveEncodeStrategy({
                    outputFormat,
                    ...(targetBitrateKbps !== undefined && { targetBitrateKbps }),
                    ...(hintBitrateKbps !== undefined && { hintBitrateKbps }),
                    sources,
                  });
                  cases++;
                  const args = buildCodecArgs(strategy);
                  expect(args).not.toContain('-ar');
                  expect(args).not.toContain('-ac');
                  for (const notice of strategy.notices) {
                    if (notice.from !== undefined) expect(notice.from).not.toBe(notice.to);
                  }
                  if (strategy.mode === 'copy') {
                    expect(args).toEqual(['-c:a', 'copy']);
                    continue;
                  }
                  const { bitrateKbps, codec } = strategy;
                  expect(Number.isInteger(bitrateKbps)).toBe(true);
                  expect(bitrateKbps).toBeGreaterThanOrEqual(MIN_PLAUSIBLE_SOURCE_BITRATE_KBPS);
                  if (codec === 'aac') {
                    expect(bitrateKbps).toBeLessThanOrEqual(MAX_AAC_TARGET_KBPS);
                  } else {
                    expect(selectMp3Table(sources)).toContain(bitrateKbps);
                  }
                  expect(args).toEqual(['-c:a', codec, '-b:a', `${bitrateKbps}k`]);
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(1000);
  });
});
