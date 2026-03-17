import type { FastifyHelmetOptions } from '@fastify/helmet';

const sharedOptions = {
  crossOriginEmbedderPolicy: false,
  frameguard: { action: 'deny' as const },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' as const },
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
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
      },
    },
  };
}
