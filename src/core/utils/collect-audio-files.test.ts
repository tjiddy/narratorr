import { describe, it } from 'vitest';

describe('collectAudioFilePaths', () => {
  describe('core behavior', () => {
    it.todo('returns audio file paths for a flat directory with mixed file types');
    it.todo('filters by default AUDIO_EXTENSIONS when no extensions option provided');
    it.todo('filters by custom extension set when provided');
    it.todo('returns empty array for empty directory');
    it.todo('returns empty array for directory with no matching audio files');
  });

  describe('recursive mode', () => {
    it.todo('descends into subdirectories and returns nested audio file paths');
    it.todo('returns files from all levels of nesting');
  });

  describe('hidden directory skipping', () => {
    it.todo('skips entries starting with . when skipHidden is true');
    it.todo('includes hidden entries when skipHidden is false (default)');
  });

  describe('non-recursive mode (default)', () => {
    it.todo('returns only direct children, ignoring subdirectories');
  });
});
