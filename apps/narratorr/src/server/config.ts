export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  isDev: process.env.NODE_ENV !== 'production',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  configPath: process.env.CONFIG_PATH || './config',
  libraryPath: process.env.LIBRARY_PATH || './audiobooks',
  dbPath: process.env.DATABASE_URL || './config/narratorr.db',
};
