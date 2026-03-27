import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { FORMAT_LABELS, MERGE_LABELS, TAG_MODE_LABELS } from '@/lib/constants';
import { ZapIcon, CheckCircleIcon, AlertCircleIcon, LoadingSpinner } from '@/components/icons';
import { FormField } from '@/components/settings/FormField';
import { outputFormatSchema, mergeBehaviorSchema, tagModeSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const processingFormSchema = z.object({
  processingEnabled: z.boolean(),
  ffmpegPath: z.string(),
  outputFormat: outputFormatSchema,
  keepOriginalBitrate: z.boolean(),
  bitrate: z.number().int().min(32).max(512),
  mergeBehavior: mergeBehaviorSchema,
  maxConcurrentProcessing: z.number().int().min(1),
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: z.preprocess(
    (v) => (typeof v === 'number' && Number.isNaN(v) ? undefined : v),
    z.number().int().min(1).optional(),
  ),
  taggingEnabled: z.boolean(),
  tagMode: tagModeSchema,
  embedCover: z.boolean(),
}).superRefine((data, ctx) => {
  if (data.processingEnabled && !data.ffmpegPath.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ffmpegPath'],
      message: 'ffmpeg path is required when processing is enabled',
    });
  }
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
    processingEnabled: settings.processing.enabled,
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
      enabled: data.processingEnabled,
      ffmpegPath: data.ffmpegPath,
      outputFormat: data.outputFormat,
      keepOriginalBitrate: data.keepOriginalBitrate,
      bitrate: data.bitrate,
      mergeBehavior: data.mergeBehavior,
      maxConcurrentProcessing: data.maxConcurrentProcessing,
      postProcessingScript: data.postProcessingScript,
      postProcessingScriptTimeout: data.postProcessingScriptTimeout,
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
          Run a script after each successful import. The audiobook folder path is passed as the first argument.
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
          registration={register('postProcessingScriptTimeout', { valueAsNumber: true })}
          error={errors.postProcessingScriptTimeout}
          min={1}
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
  const queryClient = useQueryClient();
  const [probeResult, setProbeResult] = useState<{ version: string } | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
  });

  const { register, handleSubmit, reset, watch, formState: { errors, isDirty } } = useForm<ProcessingFormData>({
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- preprocess+optional creates input/output type divergence that zodResolver can't reconcile
    resolver: zodResolver(processingFormSchema) as any,
  });

  useEffect(() => {
    if (settings && !isDirty) {
      reset(toFormData(settings));
    }
  }, [settings, reset, isDirty]);

  const mutation = useMutation({
    mutationFn: (data: ProcessingFormData) => api.updateSettings(toPayload(data)),
    onSuccess: (_result, submittedData) => {
      reset(submittedData);
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Processing settings saved');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    },
  });

  const enabled = watch('processingEnabled');
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
      const message = error instanceof Error ? error.message : 'ffmpeg probe failed';
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
      description="Audio file merge and conversion after import"
    >
      <form onSubmit={handleSubmit((data) => mutation.mutate(data))} className="space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <label htmlFor="processingEnabled" className="block text-sm font-medium">Enable Post Processing</label>
            <p className="text-sm text-muted-foreground mt-0.5">
              Merge and convert audio files after import. Requires ffmpeg.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input id="processingEnabled" type="checkbox" {...register('processingEnabled')} className="sr-only peer" />
            <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
          </label>
        </div>

        {enabled && <div className="space-y-5">
          <div>
            <label htmlFor="ffmpegPath" className="block text-sm font-medium mb-2">ffmpeg Path</label>
            <div className="flex gap-2">
              <input
                id="ffmpegPath"
                type="text"
                {...register('ffmpegPath')}
                className={`flex-1 px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.ffmpegPath ? 'border-destructive' : 'border-border'
                }`}
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
            <select
              id="outputFormat"
              {...register('outputFormat')}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            >
              {outputFormatSchema.options.map((format) => (
                <option key={format} value={format}>
                  {FORMAT_LABELS[format] ?? format}
                </option>
              ))}
            </select>
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
                <input
                  id="keepOriginalBitrate"
                  type="checkbox"
                  {...register('keepOriginalBitrate')}
                  className="sr-only peer"
                />
                <div className="w-9 h-5 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4 relative" />
                Keep original
              </label>
            </div>
            <input
              id="bitrate"
              type="number"
              {...register('bitrate', { valueAsNumber: true })}
              disabled={keepOriginalBitrate}
              className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                errors.bitrate ? 'border-destructive' : 'border-border'
              }`}
              min={32}
              max={512}
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
            <select
              id="mergeBehavior"
              {...register('mergeBehavior')}
              className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
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

          <FormField
            id="maxConcurrentProcessing"
            label="Max Concurrent Jobs"
            type="number"
            registration={register('maxConcurrentProcessing', { valueAsNumber: true })}
            error={errors.maxConcurrentProcessing}
            min={1}
            placeholder="2"
            hint="Maximum number of imports that can run simultaneously. Higher values use more CPU and disk I/O."
          />
        </div>}

        <div className="pt-6 mt-6 border-t border-border">
          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="taggingEnabled" className="block text-sm font-medium">Tag Embedding</label>
              <p className="text-sm text-muted-foreground mt-0.5">
                Write book metadata (author, title, series, narrator) into audio file tags on import. Requires ffmpeg.
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input id="taggingEnabled" type="checkbox" {...register('taggingEnabled')} className="sr-only peer" />
              <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
            </label>
          </div>

          {taggingEnabled && <div className="space-y-5 mt-5">
            <div>
              <label htmlFor="tagMode" className="block text-sm font-medium mb-2">Tag Mode</label>
              <select
                id="tagMode"
                {...register('tagMode')}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              >
                {tagModeSchema.options.map((mode) => (
                  <option key={mode} value={mode}>
                    {TAG_MODE_LABELS[mode] ?? mode}
                  </option>
                ))}
              </select>
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
                <input id="embedCover" type="checkbox" {...register('embedCover')} className="sr-only peer" />
                <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full disabled:cursor-not-allowed" />
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
