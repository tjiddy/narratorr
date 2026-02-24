import type { BookWithAuthor } from '@/lib/api';
import { formatBytes } from '@narratorr/core/utils';
import { calculateQuality, resolveBookQualityInputs, qualityTierBg } from '@narratorr/core/utils';

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

function buildAudioParts(book: BookWithAuthor): { techParts: string[]; fileParts: string[] } {
  const codec = book.audioCodec!.toUpperCase();
  const bitrate = book.audioBitrate ? formatBitrate(book.audioBitrate) : null;
  const bitrateMode = book.audioBitrateMode?.toUpperCase();
  const sampleRate = book.audioSampleRate ? formatSampleRate(book.audioSampleRate) : null;
  const channels = book.audioChannels ? formatChannels(book.audioChannels) : null;
  const fileCount = book.audioFileCount;
  const totalSize = book.audioTotalSize ? formatBytes(book.audioTotalSize) : null;
  const duration = book.audioDuration ? formatDurationLong(book.audioDuration) : null;

  const techParts = [codec, bitrate && bitrateMode ? `${bitrate} ${bitrateMode}` : bitrate, sampleRate, channels].filter(Boolean) as string[];
  const fileParts = [
    fileCount ? `${fileCount} file${fileCount > 1 ? 's' : ''}` : null,
    totalSize,
    duration ? `${duration} actual` : null,
  ].filter(Boolean) as string[];

  return { techParts, fileParts };
}

interface AudioInfoProps {
  book: BookWithAuthor;
  /** When true, renders without outer animation wrapper and uses tighter padding */
  compact?: boolean;
}

export function AudioInfo({ book, compact }: AudioInfoProps) {
  if (!book.audioCodec) return null;

  const { techParts, fileParts } = buildAudioParts(book);
  const { sizeBytes, durationSeconds } = resolveBookQualityInputs(book);
  const quality = sizeBytes && durationSeconds
    ? calculateQuality(sizeBytes, durationSeconds)
    : null;

  return (
    <div className={compact ? '' : 'animate-fade-in-up stagger-6'}>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        Audio Quality
      </h2>
      <div className={`glass-card rounded-2xl ${compact ? 'p-4' : 'p-6'} space-y-2`}>
        {quality && (
          <p className="text-sm flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded-md text-xs font-medium ${qualityTierBg(quality.tier)}`}>
              {quality.tier}
            </span>
            <span className="text-muted-foreground">{quality.mbPerHour} MB/hr</span>
          </p>
        )}
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
