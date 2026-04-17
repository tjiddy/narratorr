import { describe, it } from 'vitest';

describe('ManualImportAdapter', () => {
  describe('process', () => {
    it.todo('happy path: processes book end-to-end — book transitions to imported, event_history recorded');
    it.todo('failure path: copy failure marks import_jobs status=failed with SerializedError JSON, books.status=failed');
    it.todo('pointer mode: metadata mode is undefined — skips copy, sets phase transitions correctly');
    it.todo('copy mode: metadata mode is copy — copies files to library path');
    it.todo('move mode: metadata mode is move — moves files and removes source');
    it.todo('hydrates ManualImportJobPayload from job.metadata JSON including optional mode');
    it.todo('sets phase to done on success');
    it.todo('sets phase to failed on adapter throw');
    it.todo('detects missing book row and marks job failed with descriptive error');
  });
});
