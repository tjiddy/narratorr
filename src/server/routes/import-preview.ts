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
      // Auth note: this route inherits normal /api/* auth gating from the auth plugin.
      // BASE_PUBLIC_ROUTES is NOT extended — by the time this handler runs, the request
      // is already authenticated. Token serves as an in-session per-row capability scope.
      const { token } = request.params;
      const payload = verifyPreviewToken(token);
      if (!payload) {
        return reply.status(403).send({ error: 'Invalid or expired preview token' });
      }

      const audioPath = await resolvePreviewAudioFile(payload.path);
      if (!audioPath) {
        return reply.status(404).send({ error: 'Audio file not found' });
      }

      // realpath() both root and final audio file — symlink-aware canonicalization.
      // Plain resolve() is purely lexical and would let symlinks escape containment.
      let realRoot: string;
      let realFile: string;
      try {
        realRoot = await realpath(payload.scanRoot);
        realFile = await realpath(audioPath);
      } catch {
        request.log.warn({ scanRoot: payload.scanRoot, audioPath }, 'realpath failed — preview rejected');
        return reply.status(404).send({ error: 'Path not accessible' });
      }

      // Containment via relative + isAbsolute — handles Windows different-drive escape
      // (relative() returns absolute path on cross-drive, NOT '..'-prefixed).
      const rel = relative(realRoot, realFile);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        request.log.warn({ realRoot, realFile, rel }, 'Audio file outside scan root after symlink resolution');
        return reply.status(403).send({ error: 'Path outside scan root' });
      }

      return streamAudioFile(realFile, request, reply);
    },
  );
}
