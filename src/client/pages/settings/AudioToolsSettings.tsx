import { z } from 'zod';
import { HeadphonesIcon, CheckCircleIcon, AlertCircleIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { FORMAT_LABELS, MERGE_LABELS } from '@/lib/constants';
import { outputFormatSchema, mergeBehaviorSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { useFfmpegStatus } from '@/hooks/useFfmpegStatus';

// Only the shared merge/convert ENGINE fields live here (the "how"). Automations (the
// "when") stay on Post Processing. Each page saves ONLY its own subset of `processing`;
// the backend patch-merges, so the two pages never clobber each other's fields. The
// engine/automation field partition is enforced by processing-field-partition.test.ts.
// (Bounds mirror processingSettingsSchema; deriving via .pick() conflicts with the form's
// exactOptionalPropertyTypes contract — the partition test is the drift guard instead.)
const audioToolsSchema = z.object({
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: z.number().int().min(32).max(512),
  mergeBehavior: mergeBehaviorSchema,
  maxConcurrentProcessing: z.number().int().min(1).max(8),
});
type AudioToolsFormData = z.infer<typeof audioToolsSchema>;

function toFormData(s: AppSettings): AudioToolsFormData {
  return {
    outputFormat: s.processing.outputFormat,
    keepOriginalBitrate: s.processing.keepOriginalBitrate,
    bitrate: s.processing.bitrate,
    mergeBehavior: s.processing.mergeBehavior,
    maxConcurrentProcessing: s.processing.maxConcurrentProcessing,
  };
}

function toPayload(data: AudioToolsFormData) {
  return { processing: { ...data } };
}

function FfmpegStatusRow() {
  const { data, isLoading } = useFfmpegStatus();
  if (isLoading) return null;

  if (data?.detected) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card/40 px-4 py-3 text-sm">
        <CheckCircleIcon className="w-4 h-4 text-success shrink-0" />
        <span className="font-semibold">ffmpeg</span>
        <span className="text-muted-foreground">Detected · v{data.version}</span>
        {data.path && <span className="ml-auto font-mono text-xs text-muted-foreground/70 truncate">{data.path}</span>}
      </div>
    );
  }

  // Only the unhappy path carries setup copy — the 99% never see it.
  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <AlertCircleIcon className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
      <span>
        <span className="font-semibold text-destructive">ffmpeg not found</span>
        <span className="text-muted-foreground"> — install it, or set <code className="px-1 py-0.5 bg-muted rounded text-xs">FFMPEG_PATH</code>. Merge, Convert and Tag Embedding stay off until it resolves.</span>
      </span>
    </div>
  );
}

export function AudioToolsSettings() {
  const { form, mutation, onSubmit } = useSettingsForm<AudioToolsFormData>({
    schema: audioToolsSchema,
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toFormData,
    toPayload,
    successMessage: 'Audio tools settings saved',
  });
  const { register, handleSubmit, watch, formState: { errors, isDirty } } = form;
  const keepOriginalBitrate = watch('keepOriginalBitrate');

  return (
    <SettingsSection
      icon={<HeadphonesIcon className="w-5 h-5 text-primary" />}
      title="Merge & Convert"
      description="Applies wherever audio is merged or converted — the Merge and Bulk Convert buttons, and auto-merge downloads."
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <FfmpegStatusRow />

        <SettingsTable>
          <SettingsRow htmlFor="outputFormat" label="Output format" description="M4B keeps chapter markers; MP3 is universally compatible.">
            <div className="w-56">
              <SelectWithChevron id="outputFormat" {...register('outputFormat')}>
                {outputFormatSchema.options.map((f) => (
                  <option key={f} value={f}>{FORMAT_LABELS[f] ?? f}</option>
                ))}
              </SelectWithChevron>
            </div>
          </SettingsRow>

          <SettingsRow htmlFor="keepOriginalBitrate" label="Keep original bitrate" description="Re-encode at each file’s source bitrate.">
            <ToggleSwitch id="keepOriginalBitrate" {...register('keepOriginalBitrate')} />
          </SettingsRow>

          <SettingsRow htmlFor="bitrate" label="Target bitrate" description="The bitrate to encode to — active only when Keep original is off." muted={keepOriginalBitrate}>
            <input
              id="bitrate"
              type="number"
              {...register('bitrate', { valueAsNumber: true })}
              disabled={keepOriginalBitrate}
              min={32}
              max={512}
              step={1}
              className={`w-24 text-center ${errorInputClass(!!errors.bitrate && !keepOriginalBitrate)} disabled:cursor-not-allowed disabled:opacity-50`}
            />
            <span className="text-sm text-muted-foreground">kbps</span>
          </SettingsRow>

          <SettingsRow htmlFor="mergeBehavior" label="Merge behavior" description="When multiple audio files get combined into one chaptered file.">
            <div className="w-56">
              <SelectWithChevron id="mergeBehavior" {...register('mergeBehavior')}>
                {mergeBehaviorSchema.options.map((b) => (
                  <option key={b} value={b}>{MERGE_LABELS[b] ?? b}</option>
                ))}
              </SelectWithChevron>
            </div>
          </SettingsRow>

          <SettingsRow htmlFor="maxConcurrentProcessing" label="Max concurrent jobs" description="Manual and auto-merge share this cap. Higher uses more CPU and disk I/O.">
            <input
              id="maxConcurrentProcessing"
              type="number"
              {...register('maxConcurrentProcessing', { valueAsNumber: true })}
              min={1}
              max={8}
              step={1}
              className={`w-24 text-center ${errorInputClass(!!errors.maxConcurrentProcessing)}`}
            />
          </SettingsRow>
        </SettingsTable>

        <p className="text-sm text-muted-foreground">
          Used by the <span className="font-medium text-foreground">Merge</span> button,{' '}
          <span className="font-medium text-foreground">Bulk Convert</span>, and{' '}
          <span className="font-medium text-foreground">auto-merge downloads</span>.
        </p>

        {isDirty && (
          <button
            type="submit"
            disabled={mutation.isPending}
            className="px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in"
          >
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
        )}
      </form>
    </SettingsSection>
  );
}
