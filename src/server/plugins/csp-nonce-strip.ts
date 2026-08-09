import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

async function cspNonceStripInner(app: FastifyInstance): Promise<void> {
  // Helmet's style nonce disables unsafe-inline under CSP2. Strip it after route
  // handlers consume reply.cspNonce.script, leaving script-src untouched.
  app.addHook('onSend', async (_request, reply, payload) => {
    const csp = reply.getHeader('content-security-policy');
    if (!csp || typeof csp !== 'string') return payload;

    const cleaned = csp.replace(/(style-src[^;]*?)\s+'nonce-[a-f0-9]+'/g, '$1');
    reply.header('content-security-policy', cleaned);

    return payload;
  });
}

export default fp(cspNonceStripInner, {
  name: 'csp-nonce-strip',
  dependencies: ['@fastify/helmet'],
});
