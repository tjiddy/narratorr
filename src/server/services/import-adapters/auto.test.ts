import { describe, it } from 'vitest';

describe('AutoImportAdapter', () => {
  describe('process', () => {
    // Happy path — delegates to orchestrator
    it.todo('delegates to ImportOrchestrator.importDownload() with downloadId from metadata');
    it.todo('calls setPhase with analyzing phase before delegating');

    // Metadata validation
    it.todo('throws descriptive error when downloadId is missing from metadata');

    // Guard checks
    it.todo('throws when bookId is null on the job');

    // Failure delegation — errors propagate to worker
    it.todo('propagates error from ImportOrchestrator.importDownload() — worker marks job failed');
  });
});
