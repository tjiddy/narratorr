import { describe, it, expect } from 'vitest';
import { processingSettingsSchema } from './processing.js';

// The Audio Tools page owns the merge/convert ENGINE fields; Post Processing owns the
// automation fields. Each page saves only its own subset of `processing` (partial patch).
// This guard asserts the partition is DISJOINT and TOTAL against the canonical schema, so a
// newly-added processing field can't silently belong to neither page (or both) — it forces a
// conscious assignment. Keep these lists in sync with AudioToolsSettings / ProcessingSettingsSection.
const ENGINE_KEYS = ['outputFormat', 'keepOriginalBitrate', 'bitrate', 'mergeBehavior', 'maxConcurrentProcessing'];
const AUTOMATION_KEYS = ['autoMergeDownloads', 'postProcessingScript', 'postProcessingScriptTimeout'];

describe('processing settings field partition (Audio Tools vs Post Processing)', () => {
  it('the two pages own disjoint key-sets', () => {
    const overlap = ENGINE_KEYS.filter((k) => AUTOMATION_KEYS.includes(k));
    expect(overlap).toEqual([]);
  });

  it('the union of both pages covers every processing field exactly', () => {
    const allKeys = Object.keys(processingSettingsSchema.shape).sort();
    const partition = [...ENGINE_KEYS, ...AUTOMATION_KEYS].sort();
    expect(partition).toEqual(allKeys);
  });
});
