import { useState } from 'react';
import type { UseFormRegister, FieldErrors, UseFormWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { ZapIcon, CheckCircleIcon, AlertCircleIcon, LoadingSpinner } from '@/components/icons';
import { outputFormatSchema, mergeBehaviorSchema, type UpdateSettingsFormData } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

interface ProcessingSettingsSectionProps {
  register: UseFormRegister<UpdateSettingsFormData>;
  errors: FieldErrors<UpdateSettingsFormData>;
  watch: UseFormWatch<UpdateSettingsFormData>;
}

const FORMAT_LABELS: Record<string, string> = {
  m4b: 'M4B (recommended — chapters supported)',
  mp3: 'MP3 (no chapter support)',
};

const MERGE_LABELS: Record<string, string> = {
  always: 'Always merge',
  'multi-file-only': 'Only when multiple files',
  never: 'Never (convert only)',
};

function ProbeResultFeedback({ result, error }: { result: { version: string } | null; error: string | null }) {
  if (result) {
    return (
      <div className="mt-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg flex items-center gap-2">
        <CheckCircleIcon className="w-4 h-4 text-green-500 shrink-0" />
        <p className="text-sm text-green-500">ffmpeg {result.version} detected</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mt-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2">
        <AlertCircleIcon className="w-4 h-4 text-destructive shrink-0" />
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  return null;
}

export function ProcessingSettingsSection({ register, errors, watch }: ProcessingSettingsSectionProps) {
  const [probeResult, setProbeResult] = useState<{ version: string } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const enabled = watch('processing.enabled');
  const ffmpegPath = watch('processing.ffmpegPath');

  async function handleProbe() {
    if (!ffmpegPath?.trim()) return;
    setProbing(true);
    setProbeResult(null);
    setProbeError(null);
    try {
      const result = await api.probeFfmpeg(ffmpegPath);
      setProbeResult(result);
      toast.success(`ffmpeg ${result.version} detected`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'ffmpeg probe failed';
      setProbeError(message);
      toast.error(message);
    } finally {
      setProbing(false);
    }
  }

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Processing"
      description="Post-import audio file merge and conversion"
    >
      <div className="flex items-center justify-between">
        <div>
          <label htmlFor="processingEnabled" className="block text-sm font-medium">Enable Processing</label>
          <p className="text-sm text-muted-foreground mt-0.5">
            Merge and convert audio files after import. Requires ffmpeg.
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input id="processingEnabled" type="checkbox" {...register('processing.enabled')} className="sr-only peer" />
          <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
        </label>
      </div>

      <div className={`space-y-5 transition-opacity duration-200 ${enabled ? 'opacity-100' : 'opacity-40'}`}>
        <div>
          <label htmlFor="ffmpegPath" className="block text-sm font-medium mb-2">ffmpeg Path</label>
          <div className="flex gap-2">
            <input
              id="ffmpegPath"
              type="text"
              {...register('processing.ffmpegPath')}
              disabled={!enabled}
              className={`flex-1 px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all disabled:cursor-not-allowed ${
                errors.processing?.ffmpegPath ? 'border-destructive' : 'border-border'
              }`}
              placeholder="/usr/bin/ffmpeg"
            />
            <button
              type="button"
              onClick={handleProbe}
              disabled={!enabled || !ffmpegPath?.trim() || probing}
              className="px-4 py-3 bg-muted text-foreground font-medium rounded-xl hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap flex items-center gap-2"
            >
              {probing ? <LoadingSpinner className="w-4 h-4" /> : 'Test'}
            </button>
          </div>
          {errors.processing?.ffmpegPath && (
            <p className="text-sm text-destructive mt-1">{errors.processing.ffmpegPath.message}</p>
          )}
          <ProbeResultFeedback result={probeResult} error={probeError} />
          <p className="text-sm text-muted-foreground mt-2">
            Path to the ffmpeg binary. In Docker, this is typically <code className="px-1 py-0.5 bg-muted rounded text-xs">/usr/bin/ffmpeg</code>.
          </p>
        </div>

        <div>
          <label htmlFor="outputFormat" className="block text-sm font-medium mb-2">Output Format</label>
          <select
            id="outputFormat"
            {...register('processing.outputFormat')}
            disabled={!enabled}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all disabled:cursor-not-allowed"
          >
            {outputFormatSchema.options.map((format) => (
              <option key={format} value={format}>
                {FORMAT_LABELS[format] ?? format}
              </option>
            ))}
          </select>
          {watch('processing.outputFormat') === 'mp3' && (
            <div className="mt-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center gap-2">
              <AlertCircleIcon className="w-4 h-4 text-amber-500 shrink-0" />
              <p className="text-sm text-amber-500">MP3 does not support embedded chapter markers</p>
            </div>
          )}
        </div>

        <div>
          <label htmlFor="bitrate" className="block text-sm font-medium mb-2">Target Bitrate (kbps)</label>
          <input
            id="bitrate"
            type="number"
            {...register('processing.bitrate', { valueAsNumber: true })}
            disabled={!enabled}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all disabled:cursor-not-allowed ${
              errors.processing?.bitrate ? 'border-destructive' : 'border-border'
            }`}
            min={32}
            max={512}
            placeholder="128"
          />
          {errors.processing?.bitrate && (
            <p className="text-sm text-destructive mt-1">{errors.processing.bitrate.message}</p>
          )}
          <p className="text-sm text-muted-foreground mt-2">
            Audio bitrate for the output file (32-512 kbps). 128 is good for speech; use 64 for smaller files.
          </p>
        </div>

        <div>
          <label htmlFor="mergeBehavior" className="block text-sm font-medium mb-2">Merge Behavior</label>
          <select
            id="mergeBehavior"
            {...register('processing.mergeBehavior')}
            disabled={!enabled}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all disabled:cursor-not-allowed"
          >
            {mergeBehaviorSchema.options.map((behavior) => (
              <option key={behavior} value={behavior}>
                {MERGE_LABELS[behavior] ?? behavior}
              </option>
            ))}
          </select>
          <p className="text-sm text-muted-foreground mt-2">
            Controls when multiple audio files are merged into a single output file with chapter markers
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}
