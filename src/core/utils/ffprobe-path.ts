// Standard ffmpeg distributions install ffprobe beside ffmpeg.
export function deriveFfprobePath(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
}

export function resolveFfprobePathFromSettings(ffmpegPath: string | undefined | null): string | undefined {
  const trimmed = ffmpegPath?.trim();
  return trimmed ? deriveFfprobePath(trimmed) : undefined;
}
