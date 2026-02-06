import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/schema.ts', 'src/migrate.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
