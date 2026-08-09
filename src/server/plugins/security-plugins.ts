import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { buildHelmetOptions } from './helmet-options.js';
import cspNonceStripPlugin from './csp-nonce-strip.js';

/** Register Helmet before stripping the style nonce that disables unsafe-inline under CSP2. */
export async function registerSecurityPlugins(app: FastifyInstance, isDev: boolean): Promise<void> {
  await app.register(helmet, buildHelmetOptions(isDev));
  await app.register(cspNonceStripPlugin);
}
