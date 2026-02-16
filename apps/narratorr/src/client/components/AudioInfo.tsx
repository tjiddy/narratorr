import type { BookWithAuthor } from '@/lib/api';
import { formatBytes } from '@narratorr/core/utils';

function formatDurationLong(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function formatBitrate(bps: number): string {
  return `${Math.round(bps / 1000)} kbps`;
}

function formatSampleRate(hz: number): string {
  return `${(hz / 1000).toFixed(1)} kHz`;
}

function formatChannels(channels: number): string {
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}ch`;
}

interface AudioInfoProps {
  book: BookWithAuthor;
}

export function AudioInfo({ book }: AudioInfoProps) {
  if (!book.audioCodec) return null;

  const codec = book.audioCodec.toUpperCase();
  const bitrate = book.audioBitrate ? formatBitrate(book.audioBitrate) : null;
  const bitrateMode = book.audioBitrateMode?.toUpperCase();
  const sampleRate = book.audioSampleRate ? formatSampleRate(book.audioSampleRate) : null;
  const channels = book.audioChannels ? formatChannels(book.audioChannels) : null;
  const fileCount = book.audioFileCount;
  const totalSize = book.audioTotalSize ? formatBytes(book.audioTotalSize) : null;
  const duration = book.audioDuration ? formatDurationLong(book.audioDuration) : null;

  const techParts = [codec, bitrate && bitrateMode ? `${bitrate} ${bitrateMode}` : bitrate, sampleRate, channels].filter(Boolean);
  const fileParts = [
    fileCount ? `${fileCount} file${fileCount > 1 ? 's' : ''}` : null,
    totalSize,
    duration ? `${duration} actual` : null,
  ].filter(Boolean);

  return (
    <div className="animate-fade-in-up stagger-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Audio Quality
      </h2>
      <div className="glass-card rounded-2xl p-6 space-y-2">
        {techParts.length > 0 && (
          <p className="text-sm">
            <span className="text-muted-foreground mr-2">🎧</span>
            {techParts.join(' · ')}
          </p>
        )}
        {fileParts.length > 0 && (
          <p className="text-sm">
            <span className="text-muted-foreground mr-2">📦</span>
            {fileParts.join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}
