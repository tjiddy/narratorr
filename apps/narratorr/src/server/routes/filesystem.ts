import type { FastifyInstance } from 'fastify';
import { readdir, access, constants } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

interface BrowseQuery {
  path?: string;
}

interface BrowseResponse {
  dirs: string[];
  parent: string | null;
}

export async function filesystemRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: BrowseQuery }>('/api/filesystem/browse', async (request, reply) => {
    const rawPath = request.query.path ?? '/';
    const targetPath = resolve(rawPath);

    request.log.debug({ targetPath }, 'Browsing directory');

    let entries;
    try {
      entries = await readdir(targetPath, { withFileTypes: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read directory';
      request.log.warn({ error, targetPath }, 'Directory browse failed');
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

    const response: BrowseResponse = { dirs, parent };
    return response;
  });
}
