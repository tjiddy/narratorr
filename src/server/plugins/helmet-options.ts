import type { FastifyHelmetOptions } from '@fastify/helmet';

const sharedOptions = {
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' as const },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' as const },
  // Self-hosted app — TLS termination is handled by reverse proxies, not us.
  // HSTS would break direct HTTP access (e.g., http://192.168.x.x:3000).
  hsts: false,
};

export function buildHelmetOptions(isDev: boolean): FastifyHelmetOptions {
  if (isDev) {
    return {
      ...sharedOptions,
      contentSecurityPolicy: false,
    };
  }

  return {
    ...sharedOptions,
    enableCSPNonces: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrcAttr: ["'none'"],
        // No upgrade-insecure-requests — self-hosted app may run over plain HTTP
      },
    },
  };
}
