import { relative, isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyPreviewToken } from '../services/preview-token.js';
import { resolvePreviewAudioFile, streamAudioFile } from '../services/audio-preview-stream.js';

const paramsSchema = z.object({
  token: z.string().min(1).max(2048),
});

type Params = z.infer<typeof paramsSchema>;

export async function importPreviewRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: Params }>(
    '/api/import/preview/:token',
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      // Normal API auth still applies; the token only scopes an authenticated preview.
      const { token } = request.params;
      const payload = verifyPreviewToken(token);
      if (!payload) {
        return reply.status(403).send({ error: 'Invalid or expired preview token' });
      }

      const audioPath = await resolvePreviewAudioFile(payload.path);
      if (!audioPath) {
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      // Canonicalize both paths so symlinks cannot escape containment.
      let realRoot: string;
      let realFile: string;
      try {
        realRoot = await realpath(payload.scanRoot);
        realFile = await realpath(audioPath);
      } catch {
        request.log.warn({ scanRoot: payload.scanRoot, audioPath }, 'realpath failed — preview rejected');
        return reply.status(404).send({ error: 'Path not accessible' });
      }

      // isAbsolute also catches Windows cross-drive escapes from relative().
      const rel = relative(realRoot, realFile);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        request.log.warn({ realRoot, realFile, rel }, 'Audio file outside scan root after symlink resolution');
        return reply.status(403).send({ error: 'Path outside scan root' });
      }

      return streamAudioFile(realFile, request, reply);
    },
  );
}
