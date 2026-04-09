/**
 * Derive the ffprobe binary path from the ffmpeg binary path.
 * ffprobe ships alongside ffmpeg in all standard distributions.
 */
export function deriveFfprobePath(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

/**
 * Resolve ffprobePath from an ffmpegPath setting value.
 * Returns undefined if the value is empty or whitespace-only.
 */
export function resolveFfprobePathFromSettings(ffmpegPath: string | undefined | null): string | undefined {
  const trimmed = ffmpegPath?.trim();
  return trimmed ? deriveFfprobePath(trimmed) : undefined;
}
