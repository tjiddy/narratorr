export function getMinDetectionMs(mode: string): number {
  return mode === 'test' ? 0 : 1000;
}
