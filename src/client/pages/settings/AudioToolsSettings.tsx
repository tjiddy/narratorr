import { z } from 'zod';
import { HeadphonesIcon, CheckCircleIcon, AlertCircleIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { NumberField } from '@/components/settings/NumberField';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { FORMAT_LABELS } from '@/lib/constants';
import { outputFormatSchema, bitrateField, maxConcurrentProcessingField, DEFAULT_SETTINGS, type AppSettings } from '@shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { useFfmpegStatus } from '@/hooks/useFfmpegStatus';

// Audio Tools owns merge/convert fields; Post Processing owns automation.
// Each sends a schema-derived subset that the backend patch-merges.
const audioToolsSchema = z.object({
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: bitrateField,
  maxConcurrentProcessing: maxConcurrentProcessingField,
});
type AudioToolsFormData = z.infer<typeof audioToolsSchema>;

function toFormData(s: AppSettings): AudioToolsFormData {
  return {
    outputFormat: s.processing.outputFormat,
    keepOriginalBitrate: s.processing.keepOriginalBitrate,
    bitrate: s.processing.bitrate,
    maxConcurrentProcessing: s.processing.maxConcurrentProcessing,
  };
}

function toPayload(data: AudioToolsFormData) {
  return { processing: { ...data } };
}

function FfmpegStatusRow() {
  const { data, isLoading, isError } = useFfmpegStatus();
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

  // A failed query is not proof ffmpeg is absent, so show a distinct status.
  if (isError) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-border bg-card/40 px-4 py-3 text-sm">
        <AlertCircleIcon className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
        <span>
          <span className="font-semibold">Unable to check ffmpeg status</span>
          <span className="text-muted-foreground"> — the server didn’t respond. This is usually a connection or auth problem, not a missing binary; reload to retry.</span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
      <AlertCircleIcon className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
      <span>
        <span className="font-semibold text-destructive">ffmpeg not found</span>
        <span className="text-muted-foreground"> — install it, or set <code className="px-1 py-0.5 bg-muted rounded text-xs">FFMPEG_PATH</code>. Merge and Convert stay off until it resolves.</span>
      </span>
    </div>
  );
}

const CARD_LABEL = 'Merge & Convert';

export function AudioToolsSettings() {
  const { form, mutation, onSubmit , settingsError, refetchSettings } = useSettingsForm<AudioToolsFormData>({
    schema: audioToolsSchema,
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toFormData,
    toPayload,
    successMessage: 'Audio tools settings saved',
    label: CARD_LABEL,
  });
  const { register, handleSubmit, watch, formState: { errors, isDirty } } = form;
  const keepOriginalBitrate = watch('keepOriginalBitrate');

  return (
    <SettingsSection
      icon={<HeadphonesIcon className="w-5 h-5 text-primary" />}
      title={CARD_LABEL}
      description="Applies wherever audio is merged or converted — the Merge button and auto-merge downloads."
    >
      {/* Above the gate: this reads its own query, and a failed settings read is not a
          reason to hide an ffmpeg status that was read successfully. */}
      <FfmpegStatusRow />

      {/* M4B in Output format reads as a chosen container and Keep original as a chosen
          policy — both are schema defaults a failed read never observed. */}
      {settingsError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-red-500">Failed to load merge and convert settings.</p>
          <button
            type="button"
            onClick={refetchSettings}
            aria-label="Retry loading merge and convert settings"
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
          <SettingsTable>
            <SettingsRow htmlFor="outputFormat" label="Output format" description="M4B keeps chapter markers; MP3 is universally compatible but has no chapter support.">
              <div className="w-56">
                <SelectWithChevron id="outputFormat" {...register('outputFormat')}>
                  {outputFormatSchema.options.map((f) => (
                    <option key={f} value={f}>{FORMAT_LABELS[f] ?? f}</option>
                  ))}
                </SelectWithChevron>
              </div>
            </SettingsRow>

            <SettingsRow htmlFor="keepOriginalBitrate" label="Keep original bitrate" description="Copies the audio when the parts are compatible. Otherwise re-encodes using the source bitrate where it is known, or a conservative default where it is not, adjusted to a value the output format accepts.">
              <ToggleSwitch id="keepOriginalBitrate" {...register('keepOriginalBitrate')} />
            </SettingsRow>

            <SettingsRow htmlFor="bitrate" label="Target bitrate" description="The bitrate to encode to — active only when Keep original is off. MP3 output rounds down to the next supported rate — or up to the minimum, if lower — and its maximum depends on the source sample rate." muted={keepOriginalBitrate}>
              <NumberField
                id="bitrate"
                {...register('bitrate', { valueAsNumber: true })}
                disabled={keepOriginalBitrate}
                min={32}
                max={512}
                step={1}
                suffix="kbps"
                error={keepOriginalBitrate ? undefined : errors.bitrate?.message}
              />
            </SettingsRow>

            <SettingsRow htmlFor="maxConcurrentProcessing" label="Max concurrent jobs" description="Manual and auto-merge share this cap. Higher uses more CPU and disk I/O.">
              <NumberField
                id="maxConcurrentProcessing"
                {...register('maxConcurrentProcessing', { valueAsNumber: true })}
                min={1}
                max={8}
                step={1}
                error={errors.maxConcurrentProcessing?.message}
              />
            </SettingsRow>
          </SettingsTable>

          <p className="text-sm text-muted-foreground">
            Used by the <span className="font-medium text-foreground">Merge</span> button and{' '}
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
      )}
    </SettingsSection>
  );
}
