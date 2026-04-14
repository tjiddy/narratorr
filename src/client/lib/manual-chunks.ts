export function manualChunks(id: string): string | undefined {
  if (id.includes('node_modules/react-dom')) return 'vendor-react';
  if (id.includes('node_modules/react-router')) return 'vendor-react';
  if (id.includes('node_modules/react/')) return 'vendor-react';
}
