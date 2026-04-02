import { AlertTriangleIcon, AlertCircleIcon } from '@/components/icons';
import type { QualityGateData } from '@/lib/api/activity';

function formatMbPerHour(mbPerHour: number | null): string {
  if (mbPerHour === null) return '—';
  return `${Math.round(mbPerHour)} MB/hr`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatChannels(channels: number | null): string {
  if (channels === null) return '—';
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}ch`;
}

type Row = { label: string; current: string; downloaded: string; flagged?: boolean };

function narratorRow(data: QualityGateData): Row | null {
  if (data.narratorMatch === null) return null;
  return {
    label: 'Narrator',
    current: data.existingNarrator ?? '—',
    downloaded: data.downloadNarrator ?? '—',
    flagged: data.narratorMatch === false,
  };
}

function durationRow(data: QualityGateData): Row | null {
  const curDuration = data.existingDuration ?? null;
  const dlDuration = data.downloadedDuration ?? null;
  if (curDuration === null && dlDuration === null) return null;
  return {
    label: 'Duration',
    current: formatDuration(curDuration),
    downloaded: formatDuration(dlDuration),
    flagged: data.durationDelta !== null && Math.abs(data.durationDelta) > 0.15,
  };
}

function codecRow(data: QualityGateData): Row | null {
  const curCodec = data.existingCodec ?? null;
  if (curCodec === null && data.codec === null) return null;
  return { label: 'Codec', current: curCodec ?? '—', downloaded: data.codec ?? '—' };
}

function channelsRow(data: QualityGateData): Row | null {
  const curChannels = data.existingChannels ?? null;
  if (curChannels === null && data.channels === null) return null;
  return { label: 'Channels', current: formatChannels(curChannels), downloaded: formatChannels(data.channels) };
}

function buildRows(data: QualityGateData): Row[] {
  return [
    { label: 'Quality', current: formatMbPerHour(data.existingMbPerHour), downloaded: formatMbPerHour(data.mbPerHour) },
    narratorRow(data),
    durationRow(data),
    codecRow(data),
    channelsRow(data),
  ].filter((row): row is Row => row !== null);
}

function ProbeFailureMessage({ probeError, holdReasons }: { probeError: string | null; holdReasons: string[] }) {
  if (holdReasons.includes('unhandled_error')) {
    return (
      <p className="text-sm text-muted-foreground">
        {probeError ?? 'An unexpected error occurred.'} Manual review required.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {probeError ? `${probeError} — ` : 'Audio probe failed — '}unable to determine download quality. Manual review required.
    </p>
  );
}

export function QualityComparisonPanel({ data }: { data: QualityGateData }) {
  const rows = buildRows(data);
  const isUnhandledError = data.holdReasons?.includes('unhandled_error') ?? false;

  return (
    <div className="mt-3 p-4 bg-muted/50 rounded-xl border border-border/50 space-y-3">
      <h4 className="text-sm font-semibold flex items-center gap-2">
        Quality Comparison
        {data.probeFailure && (
          <span className="inline-flex items-center gap-1 text-xs text-destructive">
            <AlertCircleIcon className="w-3.5 h-3.5" />
            {isUnhandledError ? 'Unexpected error' : 'Probe failed'}
          </span>
        )}
      </h4>

      {data.probeFailure ? (
        <ProbeFailureMessage probeError={data.probeError} holdReasons={data.holdReasons} />
      ) : (
        <>
          {/* Comparison grid */}
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="text-muted-foreground font-medium" />
            <div className="text-muted-foreground font-medium text-center">Current</div>
            <div className="text-muted-foreground font-medium text-center">Downloaded</div>

            {rows.map((row) => (
              <div key={row.label} className="contents">
                <div className="text-muted-foreground">{row.label}</div>
                <div className="text-center">{row.current}</div>
                <div className={`text-center flex items-center justify-center gap-1 ${row.flagged ? 'text-amber-500' : ''}`}>
                  {row.downloaded}
                  {row.flagged && <AlertTriangleIcon className="w-3.5 h-3.5" />}
                </div>
              </div>
            ))}
          </div>

          {/* Hold reasons */}
          {data.holdReasons.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {data.holdReasons.map((reason) => (
                <span
                  key={reason}
                  className="px-2 py-0.5 text-xs rounded-lg bg-amber-500/10 text-amber-500"
                >
                  {reason.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
