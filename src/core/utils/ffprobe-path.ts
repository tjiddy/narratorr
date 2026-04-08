/**
 * Derive the ffprobe binary path from the ffmpeg binary path.
 * ffprobe ships alongside ffmpeg in all standard distributions.
 */
export function deriveFfprobePath(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}
