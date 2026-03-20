import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  outDir: 'dist/server',
  external: ['better-sqlite3', 'dotenv'],
  esbuildOptions(options) {
    options.define = {
      ...options.define,
      'process.env.GIT_COMMIT': JSON.stringify(process.env.GIT_COMMIT || 'unknown'),
    };
  },
});
