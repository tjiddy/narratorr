import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Restore env to original state
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  async function loadConfig() {
    const mod = await import('./config.js');
    return mod.config;
  }

  describe('PORT', () => {
    it('defaults to 3000 when PORT is not set', async () => {
      delete process.env.PORT;
      const config = await loadConfig();
      expect(config.port).toBe(3000);
    });

    it('parses a valid PORT from env', async () => {
      process.env.PORT = '8080';
      const config = await loadConfig();
      expect(config.port).toBe(8080);
    });

    it('throws on non-numeric PORT', async () => {
      process.env.PORT = 'abc';
      await expect(loadConfig()).rejects.toThrow('Invalid PORT: abc');
    });

    it('throws on PORT = 0 (below range)', async () => {
      process.env.PORT = '0';
      await expect(loadConfig()).rejects.toThrow('Invalid PORT: 0');
    });

    it('throws on negative PORT', async () => {
      process.env.PORT = '-1';
      await expect(loadConfig()).rejects.toThrow('Invalid PORT: -1');
    });

    it('throws on PORT > 65535', async () => {
      process.env.PORT = '65536';
      await expect(loadConfig()).rejects.toThrow('Invalid PORT: 65536');
    });

    it('accepts PORT = 1 (minimum valid)', async () => {
      process.env.PORT = '1';
      const config = await loadConfig();
      expect(config.port).toBe(1);
    });

    it('accepts PORT = 65535 (maximum valid)', async () => {
      process.env.PORT = '65535';
      const config = await loadConfig();
      expect(config.port).toBe(65535);
    });
  });

  describe('isDev', () => {
    it('is false when NODE_ENV is production', async () => {
      process.env.NODE_ENV = 'production';
      const config = await loadConfig();
      expect(config.isDev).toBe(false);
    });

    it('is true when NODE_ENV is development', async () => {
      process.env.NODE_ENV = 'development';
      const config = await loadConfig();
      expect(config.isDev).toBe(true);
    });

    it('is true when NODE_ENV is not set', async () => {
      delete process.env.NODE_ENV;
      const config = await loadConfig();
      expect(config.isDev).toBe(true);
    });
  });

  describe('defaults', () => {
    it('uses default CORS_ORIGIN when not set', async () => {
      delete process.env.CORS_ORIGIN;
      const config = await loadConfig();
      expect(config.corsOrigin).toBe('http://localhost:5173');
    });

    it('uses custom CORS_ORIGIN from env', async () => {
      process.env.CORS_ORIGIN = 'https://myapp.example.com';
      const config = await loadConfig();
      expect(config.corsOrigin).toBe('https://myapp.example.com');
    });

    it('uses default configPath when not set', async () => {
      delete process.env.CONFIG_PATH;
      const config = await loadConfig();
      expect(config.configPath).toBe('./config');
    });

    it('uses default libraryPath when not set', async () => {
      delete process.env.LIBRARY_PATH;
      const config = await loadConfig();
      expect(config.libraryPath).toBe('./audiobooks');
    });

    it('uses default dbPath when not set', async () => {
      delete process.env.DATABASE_URL;
      const config = await loadConfig();
      expect(config.dbPath).toBe('./config/narratorr.db');
    });

    it('falls back to default CORS_ORIGIN when set to empty string', async () => {
      process.env.CORS_ORIGIN = '';
      const config = await loadConfig();
      expect(config.corsOrigin).toBe('http://localhost:5173');
    });

    it('falls back to default configPath when set to empty string', async () => {
      process.env.CONFIG_PATH = '';
      const config = await loadConfig();
      expect(config.configPath).toBe('./config');
    });

    it('falls back to default libraryPath when set to empty string', async () => {
      process.env.LIBRARY_PATH = '';
      const config = await loadConfig();
      expect(config.libraryPath).toBe('./audiobooks');
    });

    it('falls back to default dbPath when set to empty string', async () => {
      process.env.DATABASE_URL = '';
      const config = await loadConfig();
      expect(config.dbPath).toBe('./config/narratorr.db');
    });
  });

  describe('urlBase', () => {
    it('defaults to / when URL_BASE is not set', async () => {
      delete process.env.URL_BASE;
      const config = await loadConfig();
      expect(config.urlBase).toBe('/');
    });

    it('parses URL_BASE=/narratorr from env', async () => {
      process.env.URL_BASE = '/narratorr';
      const config = await loadConfig();
      expect(config.urlBase).toBe('/narratorr');
    });

    it('normalizes empty string to /', async () => {
      process.env.URL_BASE = '';
      const config = await loadConfig();
      expect(config.urlBase).toBe('/');
    });

    it('normalizes / to /', async () => {
      process.env.URL_BASE = '/';
      const config = await loadConfig();
      expect(config.urlBase).toBe('/');
    });

    it('strips trailing slash from URL_BASE', async () => {
      process.env.URL_BASE = '/narratorr/';
      const config = await loadConfig();
      expect(config.urlBase).toBe('/narratorr');
    });

    it('accepts multi-segment path like /deep/nested/path', async () => {
      process.env.URL_BASE = '/deep/nested/path';
      const config = await loadConfig();
      expect(config.urlBase).toBe('/deep/nested/path');
    });

    it('throws on URL_BASE missing leading slash', async () => {
      process.env.URL_BASE = 'narratorr';
      await expect(loadConfig()).rejects.toThrow('Invalid URL_BASE');
    });
  });

  describe('authBypass', () => {
    it('is false when AUTH_BYPASS is not set', async () => {
      delete process.env.AUTH_BYPASS;
      const config = await loadConfig();
      expect(config.authBypass).toBe(false);
    });

    it('is true when AUTH_BYPASS is "true"', async () => {
      process.env.AUTH_BYPASS = 'true';
      const config = await loadConfig();
      expect(config.authBypass).toBe(true);
    });

    it('is false when AUTH_BYPASS is any other value', async () => {
      process.env.AUTH_BYPASS = 'yes';
      const config = await loadConfig();
      expect(config.authBypass).toBe(false);
    });
  });
});
