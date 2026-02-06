import type { FastifyInstance } from 'fastify';
import type { DownloadService } from '../services';

export async function activityRoutes(app: FastifyInstance, downloadService: DownloadService) {
  // GET /api/activity
  app.get('/api/activity', async (request) => {
    const { status } = request.query as { status?: string };
    return downloadService.getAll(status);
  });

  // GET /api/activity/active
  app.get('/api/activity/active', async () => {
    return downloadService.getActive();
  });

  // GET /api/activity/:id
  app.get<{ Params: { id: string } }>('/api/activity/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const download = await downloadService.getById(id);

    if (!download) {
      return reply.status(404).send({ error: 'Download not found' });
    }

    return download;
  });

  // DELETE /api/activity/:id (cancel)
  app.delete<{ Params: { id: string } }>('/api/activity/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const cancelled = await downloadService.cancel(id);

    if (!cancelled) {
      return reply.status(404).send({ error: 'Download not found' });
    }

    return { success: true };
  });

  // POST /api/activity/:id/retry
  app.post<{ Params: { id: string } }>('/api/activity/:id/retry', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const download = await downloadService.getById(id);

    if (!download) {
      return reply.status(404).send({ error: 'Download not found' });
    }

    if (!download.magnetUri) {
      return reply.status(400).send({ error: 'Cannot retry: no magnet URI' });
    }

    // Re-grab the download
    try {
      const newDownload = await downloadService.grab({
        magnetUri: download.magnetUri,
        title: download.title,
        bookId: download.bookId ?? undefined,
        indexerId: download.indexerId ?? undefined,
        size: download.size ?? undefined,
        seeders: download.seeders ?? undefined,
      });

      // Delete the old failed download
      await downloadService.delete(id);

      return newDownload;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });
}
