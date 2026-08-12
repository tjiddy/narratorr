import { describe, it, expect } from 'vitest';
import { processingSettingsSchema } from './processing.js';

// Each page sends a partial processing patch; this partition must remain total and disjoint.
const ENGINE_KEYS = ['outputFormat', 'keepOriginalBitrate', 'bitrate', 'maxConcurrentProcessing'];
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
