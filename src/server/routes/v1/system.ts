import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import os from 'os';
import { getVersion, getCommit, getBuildTime } from '../../utils/version.js';
import { systemV1Schema } from '@shared/schemas/v1/system.js';
import { v1ErrorHandler } from './_helpers.js';

export async function v1SystemRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (v1) => {
      v1.setErrorHandler(v1ErrorHandler);
      const typed = v1.withTypeProvider<ZodTypeProvider>();

      typed.get(
        '/system',
        {
          schema: {
            response: { 200: systemV1Schema },
          },
        },
        async () => ({
          version: getVersion(),
          commit: getCommit(),
          buildTime: getBuildTime(),
          nodeVersion: process.version,
          os: `${os.type()} ${os.release()}`,
        }),
      );
    },
    { prefix: '/api/v1' },
  );
}
