import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  outDir: 'dist/server',
  external: ['better-sqlite3'],
});
