const port = parseInt(process.env.PORT || '3000', 10);
if (isNaN(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

export const config = {
  port,
  isDev: process.env.NODE_ENV !== 'production',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  configPath: process.env.CONFIG_PATH || './config',
  libraryPath: process.env.LIBRARY_PATH || './audiobooks',
  dbPath: process.env.DATABASE_URL || './config/narratorr.db',
};
