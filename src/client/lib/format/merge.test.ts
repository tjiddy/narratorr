import { describe, it, expect } from 'vitest';
import { formatMergePhase } from './merge.js';

describe('formatMergePhase', () => {
  it('returns "Queued (position 2)" for queued phase with position', () => {
    expect(formatMergePhase('queued', undefined, 2)).toBe('Queued (position 2)');
  });

  it('returns "Queued" for queued phase without position', () => {
    expect(formatMergePhase('queued')).toBe('Queued');
  });

  it('returns "Merge started..." for starting phase', () => {
    expect(formatMergePhase('starting')).toBe('Merge started...');
  });

  it('returns "Staging files..." for staging phase', () => {
    expect(formatMergePhase('staging')).toBe('Staging files...');
  });

  it('returns "Encoding to M4B — 50%..." for processing phase with percentage 0.5', () => {
    expect(formatMergePhase('processing', 0.5)).toBe('Encoding to M4B — 50%...');
  });

  it('returns "Encoding to M4B..." for processing phase without percentage', () => {
    expect(formatMergePhase('processing')).toBe('Encoding to M4B...');
  });

  it('returns "Encoding to M4B — 0%..." for processing phase with percentage 0', () => {
    expect(formatMergePhase('processing', 0)).toBe('Encoding to M4B — 0%...');
  });

  it('returns "Encoding to M4B — 100%..." for processing phase with percentage 1.0', () => {
    expect(formatMergePhase('processing', 1.0)).toBe('Encoding to M4B — 100%...');
  });

  it('returns "Verifying output..." for verifying phase', () => {
    expect(formatMergePhase('verifying')).toBe('Verifying output...');
  });

  it('returns "Finalizing..." for finalizing phase', () => {
    expect(formatMergePhase('finalizing')).toBe('Finalizing...');
  });

  it('returns "Merging..." for unknown phase', () => {
    expect(formatMergePhase('something_unknown')).toBe('Merging...');
  });
});
