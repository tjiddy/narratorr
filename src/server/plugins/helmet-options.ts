import type { FastifyHelmetOptions } from '@fastify/helmet';

const sharedOptions = {
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' as const },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' as const },
  // HSTS would break direct HTTP; optional reverse proxies terminate TLS.
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
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
        connectSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrcAttr: ["'none'"],
        // No upgrade-insecure-requests; self-hosted instances may use plain HTTP.
      },
    },
  };
}
