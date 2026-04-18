import { describe, it } from 'vitest';

describe('streamCopyWithProgress', () => {
  describe('happy path', () => {
    it.todo('copies all files from source to target directory');
    it.todo('emits progress events at throttled intervals (>=250ms)');
    it.todo('reports final progress of 1.0 on completion');
    it.todo('preserves directory structure recursively');
  });

  describe('throttle boundary', () => {
    it.todo('two chunks arriving <250ms apart produce only one progress callback');
    it.todo('chunks >250ms apart each produce a progress callback');
  });

  describe('edge cases', () => {
    it.todo('empty directory (0 bytes total): reports 100% immediately or skips progress');
    it.todo('single file copy works correctly');
  });

  describe('copy verification', () => {
    it.todo('passes at exactly 99% threshold');
    it.todo('fails below 99% threshold — throws error');
  });

  describe('move mode', () => {
    it.todo('removes source directory after successful copy');
    it.todo('does not remove source if copy verification fails');
  });

  describe('error handling', () => {
    it.todo('mid-stream failure produces partial progress + throws error');
  });
});
