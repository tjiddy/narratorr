import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

async function cspNonceStripInner(app: FastifyInstance): Promise<void> {
  // Strip the helmet-injected style nonce from the CSP header before the response is sent.
  // @fastify/helmet with enableCSPNonces: true unconditionally injects 'nonce-<hex>' into every
  // directive that contains 'self', including style-src. Per CSP Level 2, the presence of any
  // nonce in a directive silently disables 'unsafe-inline' in that directive — so we must remove
  // it from style-src to preserve 'unsafe-inline' for the app's inline style behavior.
  // The onSend hook runs after the route handler, so reply.cspNonce.script is already consumed
  // by sendIndexHtml() before we mutate the header here.
  app.addHook('onSend', async (_request, reply, payload) => {
    const csp = reply.getHeader('content-security-policy');
    if (!csp || typeof csp !== 'string') return payload;

    // Remove 'nonce-<hex>' token only from the style-src segment.
    // Each directive is separated by ';'. We find the style-src segment and strip the nonce token.
    const cleaned = csp.replace(/(style-src[^;]*?)\s+'nonce-[a-f0-9]+'/g, '$1');
    reply.header('content-security-policy', cleaned);

    return payload;
  });
}

export default fp(cspNonceStripInner, {
  name: 'csp-nonce-strip',
  dependencies: ['@fastify/helmet'],
});
