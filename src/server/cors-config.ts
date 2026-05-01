export const DEV_CORS_ORIGINS: string[] = ['http://localhost:5173', 'http://localhost:3000'];

export function buildCorsOptions(
  config: { isDev: boolean; corsOrigin: string },
): { origin: string[] | string; credentials: true } {
  if (config.isDev) {
    return { origin: DEV_CORS_ORIGINS, credentials: true };
  }
  return { origin: config.corsOrigin, credentials: true };
}
