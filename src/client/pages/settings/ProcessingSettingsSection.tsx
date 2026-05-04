import { useState } from 'react';
import { type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { FORMAT_LABELS, MERGE_LABELS, TAG_MODE_LABELS } from '@/lib/constants';
import { ZapIcon, CheckCircleIcon, AlertCircleIcon, LoadingSpinner } from '@/components/icons';
import { FormField } from '@/components/settings/FormField';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { outputFormatSchema, mergeBehaviorSchema, tagModeSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const processingFormSchema = z.object({
  ffmpegPath: z.string(),
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: z.number().int().min(32).max(512),
  mergeBehavior: mergeBehaviorSchema,
  maxConcurrentProcessing: z.number().int().min(1),
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: z.number().int().min(1).optional(),
  taggingEnabled: z.boolean(),
  tagMode: tagModeSchema,
  embedCover: z.boolean(),
}).superRefine((data, ctx) => {
  if (data.postProcessingScript?.trim() && data.postProcessingScriptTimeout == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['postProcessingScriptTimeout'],
      message: 'Timeout is required when a post-processing script is configured',
    });
  }
});

type ProcessingFormData = z.infer<typeof processingFormSchema>;

function toFormData(settings: AppSettings): ProcessingFormData {
  return {
    ffmpegPath: settings.processing.ffmpegPath,
    outputFormat: settings.processing.outputFormat,
    keepOriginalBitrate: settings.processing.keepOriginalBitrate,
    bitrate: settings.processing.bitrate,
    mergeBehavior: settings.processing.mergeBehavior,
    maxConcurrentProcessing: settings.processing.maxConcurrentProcessing,
    postProcessingScript: settings.processing.postProcessingScript,
    postProcessingScriptTimeout: settings.processing.postProcessingScriptTimeout,
    taggingEnabled: settings.tagging.enabled,
    tagMode: settings.tagging.mode,
    embedCover: settings.tagging.embedCover,
  };
}

function toPayload(data: ProcessingFormData) {
  return {
    processing: {
      ffmpegPath: data.ffmpegPath,
      outputFormat: data.outputFormat,
      keepOriginalBitrate: data.keepOriginalBitrate,
      bitrate: data.bitrate,
      mergeBehavior: data.mergeBehavior,
      maxConcurrentProcessing: data.maxConcurrentProcessing,
      postProcessingScript: data.postProcessingScript,
      ...(data.postProcessingScriptTimeout !== undefined && { postProcessingScriptTimeout: data.postProcessingScriptTimeout }),
    },
    tagging: {
      enabled: data.taggingEnabled,
      mode: data.tagMode,
      embedCover: data.embedCover,
    },
  };
}

function CustomScriptSection({ register, errors }: Pick<UseFormReturn<ProcessingFormData>, 'register'> & { errors: UseFormReturn<ProcessingFormData>['formState']['errors'] }) {
  return (
    <div className="pt-6 mt-6 border-t border-border">
      <div className="mb-4">
        <h3 className="text-sm font-medium">Custom Script</h3>
        <p className="text-sm text-muted-foreground mt-0.5">
          Run a custom script after each successful import. To run ffmpeg or other transforms on each downloaded book, configure a post-processing script here.
        </p>
      </div>
      <div className="space-y-5">
        <FormField
          id="postProcessingScript"
          label="Post-Processing Script"
          registration={register('postProcessingScript')}
          error={errors.postProcessingScript}
          placeholder="/path/to/script.sh"
          hint={<>Absolute path to a script. Leave empty to disable. Environment variables: <code className="px-1 py-0.5 bg-muted rounded text-xs">NARRATORR_BOOK_TITLE</code>, <code className="px-1 py-0.5 bg-muted rounded text-xs">NARRATORR_BOOK_AUTHOR</code>, <code className="px-1 py-0.5 bg-muted rounded text-xs">NARRATORR_IMPORT_PATH</code>, <code className="px-1 py-0.5 bg-muted rounded text-xs">NARRATORR_IMPORT_FILE_COUNT</code>.</>}
        />
        <FormField
          id="postProcessingScriptTimeout"
          label="Script Timeout (seconds)"
          type="number"
          registration={register('postProcessingScriptTimeout', { setValueAs: (v: string) => { const n = Number(v); return v === '' || Number.isNaN(n) ? undefined : n; } })}
          error={errors.postProcessingScriptTimeout}
          min={1}
          step={1}
          placeholder="300"
          hint="Maximum time in seconds before the script is killed. Default: 300 (5 minutes)."
        />
      </div>
    </div>
  );
}

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

// eslint-disable-next-line max-lines-per-function -- linear form: ffmpeg, processing, and tagging sections
export function ProcessingSettingsSection() {
  const [probeResult, setProbeResult] = useState<{ version: string } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const { form, mutation, onSubmit } = useSettingsForm<ProcessingFormData>({
    schema: processingFormSchema,
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toFormData,
    toPayload,
    successMessage: 'Processing settings saved',
  });

  const { register, handleSubmit, watch, formState: { errors, isDirty } } = form;

  const ffmpegPath = watch('ffmpegPath');
  const keepOriginalBitrate = watch('keepOriginalBitrate');
  const taggingEnabled = watch('taggingEnabled');
  const currentOutputFormat = watch('outputFormat');

  async function handleProbe() {
    if (!ffmpegPath?.trim()) return;
    setProbing(true);
    setProbeResult(null);
    setProbeError(null);
    try {
      const result = await api.probeFfmpeg(ffmpegPath);
      setProbeResult(result);
      toast.success(`ffmpeg ${result.version} detected`);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      setProbeError(message);
      toast.error(message);
    } finally {
      setProbing(false);
    }
  }

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Post Processing"
      description="Audio file merge and conversion for Merge and Bulk operations"
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div className="space-y-5">
          <div>
            <label htmlFor="ffmpegPath" className="block text-sm font-medium mb-2">ffmpeg Path</label>
            <div className="flex gap-2">
              <input
                id="ffmpegPath"
                type="text"
                {...register('ffmpegPath')}
                className={`flex-1 ${errorInputClass(!!errors.ffmpegPath)}`}
                placeholder="/usr/bin/ffmpeg"
              />
              <button
                type="button"
                onClick={handleProbe}
                disabled={!ffmpegPath?.trim() || probing}
                className="px-4 py-3 bg-muted text-foreground font-medium rounded-xl hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed transition-all whitespace-nowrap flex items-center gap-2"
              >
                {probing ? <LoadingSpinner className="w-4 h-4" /> : 'Test'}
              </button>
            </div>
            {errors.ffmpegPath && (
              <p className="text-sm text-destructive mt-1">{errors.ffmpegPath.message}</p>
            )}
            <ProbeResultFeedback result={probeResult} error={probeError} />
            <p className="text-sm text-muted-foreground mt-2">
              Path to the ffmpeg binary. In Docker, this is typically <code className="px-1 py-0.5 bg-muted rounded text-xs">/usr/bin/ffmpeg</code>.
            </p>
          </div>

          <div>
            <label htmlFor="outputFormat" className="block text-sm font-medium mb-2">Output Format</label>
            <SelectWithChevron id="outputFormat" {...register('outputFormat')}>
              {outputFormatSchema.options.map((format) => (
                <option key={format} value={format}>
                  {FORMAT_LABELS[format] ?? format}
                </option>
              ))}
            </SelectWithChevron>
            {currentOutputFormat === 'mp3' && (
              <div className="mt-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-center gap-2">
                <AlertCircleIcon className="w-4 h-4 text-amber-500 shrink-0" />
                <p className="text-sm text-amber-500">MP3 does not support embedded chapter markers</p>
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label htmlFor="bitrate" className="block text-sm font-medium">Target Bitrate (kbps)</label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <ToggleSwitch id="keepOriginalBitrate" size="compact" {...register('keepOriginalBitrate')} />
                Keep original
              </label>
            </div>
            <input
              id="bitrate"
              type="number"
              {...register('bitrate', { valueAsNumber: true })}
              disabled={keepOriginalBitrate}
              className={`${errorInputClass(!!errors.bitrate)} disabled:cursor-not-allowed disabled:opacity-50`}
              min={32}
              max={512}
              step={1}
              placeholder="128"
            />
            {errors.bitrate && !keepOriginalBitrate && (
              <p className="text-sm text-destructive mt-1">{errors.bitrate.message}</p>
            )}
            <p className="text-sm text-muted-foreground mt-2">
              {keepOriginalBitrate
                ? 'Files will be re-encoded using the original source bitrate.'
                : 'Audio bitrate for the output file (32-512 kbps). 128 is good for speech; use 64 for smaller files.'}
            </p>
          </div>

          <div>
            <label htmlFor="mergeBehavior" className="block text-sm font-medium mb-2">Merge Behavior</label>
            <SelectWithChevron id="mergeBehavior" {...register('mergeBehavior')}>
              {mergeBehaviorSchema.options.map((behavior) => (
                <option key={behavior} value={behavior}>
                  {MERGE_LABELS[behavior] ?? behavior}
                </option>
              ))}
            </SelectWithChevron>
            <p className="text-sm text-muted-foreground mt-2">
              Controls when multiple audio files are merged into a single output file with chapter markers
            </p>
          </div>

          <FormField
            id="maxConcurrentProcessing"
            label="Max Concurrent Jobs"
            type="number"
            registration={register('maxConcurrentProcessing', { valueAsNumber: true })}
            error={errors.maxConcurrentProcessing}
            min={1}
            step={1}
            placeholder="2"
            hint="Maximum number of imports that can run simultaneously. Higher values use more CPU and disk I/O."
          />
        </div>

        <div className="pt-6 mt-6 border-t border-border">
          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="taggingEnabled" className="block text-sm font-medium">Tag Embedding</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Write book metadata (author, title, series, narrator) into audio file tags on import. Requires ffmpeg.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <ToggleSwitch id="taggingEnabled" {...register('taggingEnabled')} />
            </label>
          </div>

          {taggingEnabled && <div className="space-y-5 mt-5">
            <div>
              <label htmlFor="tagMode" className="block text-sm font-medium mb-2">Tag Mode</label>
              <SelectWithChevron id="tagMode" {...register('tagMode')}>
                {tagModeSchema.options.map((mode) => (
                  <option key={mode} value={mode}>
                    {TAG_MODE_LABELS[mode] ?? mode}
                  </option>
                ))}
              </SelectWithChevron>
              <p className="text-sm text-muted-foreground mt-2">
                &ldquo;Populate missing&rdquo; only writes tags to fields that are currently empty. &ldquo;Overwrite&rdquo; replaces all tag fields.
              </p>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <label htmlFor="embedCover" className="block text-sm font-medium">Embed Cover Art</label>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Embed the book&rsquo;s cover image into audio file tags
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <ToggleSwitch id="embedCover" {...register('embedCover')} />
              </label>
            </div>
          </div>}
        </div>

        <CustomScriptSection register={register} errors={errors} />

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
