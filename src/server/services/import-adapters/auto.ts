import type { ImportAdapter, ImportAdapterContext, ImportJob, AutoImportJobPayload } from './types.js';
import type { ImportOrchestrator } from '../import-orchestrator.js';

export class AutoImportAdapter implements ImportAdapter {
  readonly type = 'auto' as const;

  constructor(private importOrchestrator: ImportOrchestrator) {}

  async process(job: ImportJob, ctx: ImportAdapterContext): Promise<void> {
    const { log } = ctx;

    const bookId = job.bookId;
    if (bookId == null) {
      throw new Error('AutoImportAdapter requires a bookId on the job');
    }

    let payload: AutoImportJobPayload;
    try {
      payload = JSON.parse(job.metadata);
    } catch {
      throw new Error('AutoImportAdapter: malformed metadata JSON');
    }

    if (typeof payload.downloadId !== 'number') {
      throw new Error('AutoImportAdapter: downloadId missing from metadata');
    }

    log.info({ bookId, downloadId: payload.downloadId }, 'Processing auto import');

    await ctx.setPhase('analyzing');

    // Delegate to ImportOrchestrator.importDownload() — the full side-effect wrapper.
    // This preserves all success/failure side effects: SSE, tagging, post-processing,
    // notifications, event history, blacklist + retry-search.
    await this.importOrchestrator.importDownload(payload.downloadId, {
      setPhase: ctx.setPhase,
      emitProgress: ctx.emitProgress,
    });
  }
}
