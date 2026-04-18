import { describe, it } from 'vitest';

describe('ImportBatchBanner', () => {
  describe('visibility', () => {
    it.todo('renders when import jobs exist in non-terminal states');
    it.todo('renders when most recent terminal job completed <60s ago');
    it.todo('hides when all jobs terminal and completedAt >60s ago');
    it.todo('hides when no import jobs exist');
  });

  describe('counts', () => {
    it.todo('shows correct X of Y processed, A imported, B failed');
    it.todo('progress bar width proportional to X/Y');
  });

  describe('failed link', () => {
    it.todo('"B failed →" link navigates to /activity?tab=history&filter=import_failed when B > 0');
    it.todo('does not render failed link when B is 0');
  });
});
