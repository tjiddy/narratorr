import { describe, it } from 'vitest';

describe('BookRejectionService', () => {
  describe('rejectAsWrongRelease', () => {
    it.todo('blacklists release with reason wrong_content and stored identifiers');
    it.todo('blacklists with guid only when lastGrabInfoHash is null');
    it.todo('blacklists with infoHash only when lastGrabGuid is null');
    it.todo('blacklists with both identifiers when both present');
    it.todo('deletes book files best-effort via BookService.deleteBookFiles');
    it.todo('continues when file deletion throws (best-effort)');
    it.todo('skips file deletion when book path is null');
    it.todo('resets book status to wanted and nulls all 14 fields (path, size, 10 audio, lastGrabGuid, lastGrabInfoHash)');
    it.todo('preserves non-file fields (title, description, coverUrl, seriesName, etc.)');
    it.todo('records wrong_release event with correct bookId and identifiers in reason');
    it.todo('continues when event recording fails (fire-and-forget)');
    it.todo('triggers re-search when redownloadFailed is true');
    it.todo('skips re-search when redownloadFailed is false');
    it.todo('skips re-search when settings lookup fails (matches QGO policy)');
    it.todo('continues when blacklist creation fails');
    it.todo('returns success even when file deletion and event recording fail');
  });
});
