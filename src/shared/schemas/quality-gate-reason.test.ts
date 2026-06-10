import { describe, it, expect, expectTypeOf } from 'vitest';
import type { z } from 'zod';
import { qualityGateReasonSchema, type QualityGateReason } from './quality-gate-reason.js';
import type { QualityDecisionReason } from '../../server/services/quality-gate.types.js';
import type { QualityGateData } from '../../client/lib/api/activity.js';

/** A fully-populated, well-formed reason blob (all 16 launch keys present). */
const fullReason = {
  action: 'held' as const,
  mbPerHour: 60,
  existingMbPerHour: 40,
  narratorMatch: true,
  existingNarrator: 'John Smith',
  downloadNarrator: 'John Smith',
  durationDelta: 0.05,
  existingDuration: 7200,
  downloadedDuration: 7500,
  codec: 'AAC',
  channels: 2,
  existingCodec: 'MP3',
  existingChannels: 1,
  probeFailure: false,
  probeError: null,
  holdReasons: ['narrator_mismatch'],
};

describe('quality-gate-reason — type/schema drift guard (#1362)', () => {
  // Both server and client types must derive from this schema. These assertions fail
  // on EITHER drift direction — a schema key missing from a type AND a type key missing
  // from the schema — closing the gap that `satisfies z.ZodType<T>` (one-directional)
  // leaves open. Mirrors src/server/services/import-adapters/types.test.ts:39.
  it('QualityDecisionReason (server) equals z.infer of the schema', () => {
    expectTypeOf<z.infer<typeof qualityGateReasonSchema>>().toEqualTypeOf<QualityDecisionReason>();
  });

  it('QualityGateData (client) equals z.infer of the schema', () => {
    expectTypeOf<z.infer<typeof qualityGateReasonSchema>>().toEqualTypeOf<QualityGateData>();
  });

  it('QualityGateReason and the two consumer types are mutually equal', () => {
    expectTypeOf<QualityGateReason>().toEqualTypeOf<QualityDecisionReason>();
    expectTypeOf<QualityGateReason>().toEqualTypeOf<QualityGateData>();
  });
});

describe('qualityGateReasonSchema — runtime contract (#1362, carries #1305 cases)', () => {
  it('parses a full 16-key object', () => {
    expect(qualityGateReasonSchema.safeParse(fullReason).success).toBe(true);
  });

  it('rejects null for a non-null field (action)', () => {
    expect(qualityGateReasonSchema.safeParse({ ...fullReason, action: null }).success).toBe(false);
  });

  it('rejects null for a non-null field (probeFailure)', () => {
    expect(qualityGateReasonSchema.safeParse({ ...fullReason, probeFailure: null }).success).toBe(false);
  });

  it('rejects null for a non-null field (holdReasons)', () => {
    expect(qualityGateReasonSchema.safeParse({ ...fullReason, holdReasons: null }).success).toBe(false);
  });

  it('rejects a missing required key', () => {
    const { mbPerHour: _m, ...missing } = fullReason;
    expect(qualityGateReasonSchema.safeParse(missing).success).toBe(false);
  });

  it('tolerates extra keys (strip, not strict)', () => {
    const result = qualityGateReasonSchema.safeParse({ ...fullReason, futureField: 'x' });
    expect(result.success).toBe(true);
    if (result.success) expect('futureField' in result.data).toBe(false);
  });
});
