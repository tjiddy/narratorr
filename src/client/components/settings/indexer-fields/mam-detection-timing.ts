export function getMinDetectionMs(mode: string): number {
  return mode === 'test' ? 0 : 1000;
}

export const MIN_DETECTION_MS = getMinDetectionMs(import.meta.env.MODE);
