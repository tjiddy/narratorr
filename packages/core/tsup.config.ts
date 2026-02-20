import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/indexers/index.ts',
    'src/download-clients/index.ts',
    'src/utils/index.ts',
    'src/utils/audio-scanner.ts',
    'src/utils/book-discovery.ts',
    'src/metadata/index.ts',
    'src/prowlarr/index.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
