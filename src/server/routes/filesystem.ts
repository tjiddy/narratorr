import type { FastifyInstance } from 'fastify';
import { readdir, access, constants } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, extname, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


const browseQuerySchema = z.object({
  path: z.string().optional(),
  // #2435 AC20: opt-in. Omitted, the response is byte-for-byte today's `{ dirs, parent }`, so
  // PathInput and the library-path settings browser are provably unaffected. An unrecognized value
  // is a 400 from this schema rather than a silent fall back to the legacy shape.
  include: z.enum(['audio']).optional(),
});

/** Supported-audio entries in `targetPath`, readable and non-hidden.
 *
 * The readability filter mirrors the `dirs` walk. The hidden-name rule is NEW TO THIS ROUTE — the
 * legacy `dirs` loop checks only `isDirectory()` and readability, so a readable `.hidden` directory
 * is still returned, and that is deliberately left alone: this AC adds a capability rather than
 * silently narrowing an existing one. */
async function listAudioFiles(targetPath: string, entries: Dirent[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || isHiddenName(entry.name)) continue;
    if (!AUDIO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    try {
      await access(join(targetPath, entry.name), constants.R_OK);
      files.push(entry.name);
    } catch {
      // Skip unreadable files silently, mirroring the dirs walk.
    }
  }
  files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return files;
}

export async function filesystemRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: z.infer<typeof browseQuerySchema> }>(
    '/api/filesystem/browse',
    {
      schema: { querystring: browseQuerySchema },
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { path: rawPath, include } = request.query;
      const targetPath = resolve(rawPath ?? '/');

      request.log.debug({ targetPath }, 'Browsing directory');

      let entries;
      try {
        entries = await readdir(targetPath, { withFileTypes: true });
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        request.log.warn({ error: serializeError(error), targetPath }, 'Directory browse failed');
        return reply.status(400).send({ error: message });
      }

      const dirs: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            await access(join(targetPath, entry.name), constants.R_OK);
            dirs.push(entry.name);
          } catch {
            // Skip unreadable directories silently (AC3)
          }
        }
      }

      dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      const parsed = parse(targetPath);
      const isRoot = targetPath === parsed.root;
      const parent = isRoot ? null : dirname(targetPath);

      if (include !== 'audio') return { dirs, parent };
      return { dirs, parent, files: await listAudioFiles(targetPath, entries) };
    },
  );
}
