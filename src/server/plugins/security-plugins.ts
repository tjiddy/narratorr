import type { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { buildHelmetOptions } from './helmet-options.js';
import cspNonceStripPlugin from './csp-nonce-strip.js';

/**
 * Register security-related plugins in the order required for correct behavior:
 * 1. @fastify/helmet — sets security headers and injects CSP nonces into all directives
 * 2. cspNonceStripPlugin — strips the style nonce from the CSP header (onSend) so
 *    'unsafe-inline' in style-src is honored (CSP Level 2 ignores it when any nonce is present)
 *
 * Called from both src/server/index.ts and tests so the test app wiring
 * cannot silently diverge from production.
 */
export async function registerSecurityPlugins(app: FastifyInstance, isDev: boolean): Promise<void> {
  await app.register(helmet, buildHelmetOptions(isDev));
  await app.register(cspNonceStripPlugin);
}
