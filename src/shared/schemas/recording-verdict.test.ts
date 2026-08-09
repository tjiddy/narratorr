import { describe, it, expect } from 'vitest';
import { recordingVerdictSchema, type RecordingVerdict } from './recording-verdict.js';
// Tests may cross the shared-to-core boundary to detect public type drift.
import type { RecordingVerdict as CoreRecordingVerdict } from '@core/utils/recording-identity.js';

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('recordingVerdict canonical source (#1741)', () => {
  it('preserves the three established verdict values', () => {
    expect([...recordingVerdictSchema.options].sort()).toEqual(
      ['different-recording', 'review', 'same-recording'],
    );
  });

  it('rejects an unknown verdict at the schema layer', () => {
    expect(recordingVerdictSchema.safeParse('maybe-recording').success).toBe(false);
  });

  it('core RecordingVerdict and the shared union have not drifted', () => {
    const aligned: Equals<RecordingVerdict, CoreRecordingVerdict> = true;
    expect(aligned).toBe(true);
  });
});
