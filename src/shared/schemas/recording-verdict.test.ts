import { describe, it, expect } from 'vitest';
import { recordingVerdictValues, recordingVerdictSchema, type RecordingVerdict } from './recording-verdict.js';
// Test files are exempt from the `src/shared` → `src/core` import boundary
// (eslint.config.js ignores `**/*.test.ts`), so this drift guard can reach into
// core to pin the core ↔ shared relationship at the type level.
import type { RecordingVerdict as CoreRecordingVerdict } from '../../core/utils/recording-identity.js';

/** Compile-time mutual-assignability check — true only when A and B are the same union. */
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('recordingVerdict canonical source (#1741)', () => {
  it('the tuple and the derived z.enum stay set-equal (no drift)', () => {
    expect(new Set(recordingVerdictValues)).toEqual(new Set(recordingVerdictSchema.options));
  });

  it('preserves the three established verdict values', () => {
    expect([...recordingVerdictValues].sort()).toEqual(
      ['different-recording', 'review', 'same-recording'],
    );
  });

  it('rejects an unknown verdict at the schema layer', () => {
    expect(recordingVerdictSchema.safeParse('maybe-recording').success).toBe(false);
  });

  it('core RecordingVerdict and the shared union have not drifted', () => {
    // Fails the build (TS2322) if core's `RecordingVerdict` ever stops being the
    // shared union — e.g. a future dev replaces the re-export with a hand-written
    // literal union that adds or drops a value.
    const aligned: Equals<RecordingVerdict, CoreRecordingVerdict> = true;
    expect(aligned).toBe(true);
  });
});
