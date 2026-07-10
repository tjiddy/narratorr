import { type ReactNode } from 'react';
import { type UseFormReturn } from 'react-hook-form';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { ZapIcon, AlertTriangleIcon } from '@/components/icons';
import { FormField } from '@/components/settings/FormField';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { TAG_MODE_LABELS } from '@/lib/constants';
import { tagModeSchema, postProcessingScriptTimeoutField, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { useFfmpegStatus } from '@/hooks/useFfmpegStatus';

// Post Processing = the "when": automations that fire after a download. The merge/convert
// ENGINE config (the "how") lives on the Audio Tools page. This form owns the processing
// automation fields + the whole tagging category; each saves as a partial patch so it never
// clobbers the Audio Tools engine subset.
const processingFormSchema = z.object({
  autoMergeDownloads: z.boolean(),
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: postProcessingScriptTimeoutField.optional(),
  taggingEnabled: z.boolean(),
  tagMode: tagModeSchema,
  embedCover: z.boolean(),
  writeOpf: z.boolean(),
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
    autoMergeDownloads: settings.processing.autoMergeDownloads,
    postProcessingScript: settings.processing.postProcessingScript,
    postProcessingScriptTimeout: settings.processing.postProcessingScriptTimeout,
    taggingEnabled: settings.tagging.enabled,
    tagMode: settings.tagging.mode,
    embedCover: settings.tagging.embedCover,
    writeOpf: settings.tagging.writeOpf,
  };
}

function toPayload(data: ProcessingFormData) {
  return {
    processing: {
      autoMergeDownloads: data.autoMergeDownloads,
      postProcessingScript: data.postProcessingScript,
      ...(data.postProcessingScriptTimeout !== undefined && { postProcessingScriptTimeout: data.postProcessingScriptTimeout }),
    },
    tagging: {
      enabled: data.taggingEnabled,
      mode: data.tagMode,
      embedCover: data.embedCover,
      writeOpf: data.writeOpf,
    },
  };
}

/** "needs ffmpeg" note shown under a gated automation when ffmpeg isn't detected. */
function GateNote() {
  return (
    <span className="inline-flex items-center gap-1.5 mt-2 text-xs font-medium text-destructive">
      <AlertTriangleIcon className="w-3.5 h-3.5" />
      ffmpeg not found —{' '}
      <Link to="/settings/audio-tools" className="underline underline-offset-2">see ffmpeg requirements in Audio Tools</Link>
    </span>
  );
}

function AutoMergeDescription({ gated }: { gated: boolean }): ReactNode {
  return (
    <>
      Combine a multi-file download into one chaptered file after it lands. Downloads only — never Library or Manual Import.
      {gated ? <GateNote /> : (
        <Link to="/settings/audio-tools" className="mt-2 flex items-center gap-1 text-xs text-primary w-fit">
          uses your Merge &amp; Convert settings — Audio Tools →
        </Link>
      )}
    </>
  );
}

function CustomScriptSection({ register, errors }: Pick<UseFormReturn<ProcessingFormData>, 'register'> & { errors: UseFormReturn<ProcessingFormData>['formState']['errors'] }) {
  return (
    <div className="pt-6 mt-6 border-t border-border">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">Custom script</h3>
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

export function ProcessingSettingsSection() {
  const ffmpegStatus = useFfmpegStatus();
  // Optimistic while the status query LOADS — avoids a flash of "needs ffmpeg" on a
  // normal (ffmpeg-present) install — but fail SAFE on a query error: an errored status
  // fetch gates the toggles (disabled) rather than leaving them enabled on a box where
  // ffmpeg may be absent. Real enforcement is still the backend FFMPEG_NOT_CONFIGURED gate.
  const ffmpegAvailable = ffmpegStatus.isError ? false : ffmpegStatus.data?.detected !== false;

  const { form, mutation, onSubmit } = useSettingsForm<ProcessingFormData>({
    schema: processingFormSchema,
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toFormData,
    toPayload,
    successMessage: 'Post processing settings saved',
  });

  const { register, handleSubmit, watch, formState: { errors, isDirty } } = form;
  const taggingEnabled = watch('taggingEnabled');
  const autoMergeDownloads = watch('autoMergeDownloads');

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title="Post Processing"
      description="Automations that run on their own after a download lands. None run on Library or Manual Import."
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          <SettingsRow
            htmlFor="autoMergeDownloads"
            label={<>Auto-merge multi-file downloads {!ffmpegAvailable && <span className="ml-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground border border-border rounded-full px-1.5 py-0.5">needs ffmpeg</span>}</>}
            description={<AutoMergeDescription gated={!ffmpegAvailable} />}
            muted={!ffmpegAvailable}
          >
            <ToggleSwitch id="autoMergeDownloads" disabled={!ffmpegAvailable && !autoMergeDownloads} {...register('autoMergeDownloads')} />
          </SettingsRow>

          <SettingsRow
            htmlFor="taggingEnabled"
            label={<>Tag Embedding {!ffmpegAvailable && <span className="ml-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground border border-border rounded-full px-1.5 py-0.5">needs ffmpeg</span>}</>}
            description={<>Write book metadata into the audio file’s tags on import. Series, series part, subtitle, ASIN, and publisher survive on MP3 but are dropped on M4B by the container.{!ffmpegAvailable && <GateNote />}</>}
            muted={!ffmpegAvailable}
          >
            <ToggleSwitch id="taggingEnabled" disabled={!ffmpegAvailable && !taggingEnabled} {...register('taggingEnabled')} />
          </SettingsRow>

          {taggingEnabled && ffmpegAvailable && (
            <SettingsRow htmlFor="tagMode" label="Tag mode" description="“Populate missing” only writes empty fields; “Overwrite” replaces all tag fields.">
              <div className="w-48">
                <SelectWithChevron id="tagMode" {...register('tagMode')}>
                  {tagModeSchema.options.map((mode) => (
                    <option key={mode} value={mode}>{TAG_MODE_LABELS[mode] ?? mode}</option>
                  ))}
                </SelectWithChevron>
              </div>
            </SettingsRow>
          )}

          {taggingEnabled && ffmpegAvailable && (
            <SettingsRow htmlFor="embedCover" label="Embed cover art" description="Embed the book’s cover image into audio file tags.">
              <ToggleSwitch id="embedCover" {...register('embedCover')} />
            </SettingsRow>
          )}

          <SettingsRow
            htmlFor="writeOpf"
            label="OPF metadata sidecar"
            description={<>Write a <code className="px-1 py-0.5 bg-muted rounded text-xs">metadata.opf</code> into each book folder on import. Using Audiobookshelf? Enable this and set “Prefer OPF metadata” in ABS.</>}
          >
            <ToggleSwitch id="writeOpf" {...register('writeOpf')} />
          </SettingsRow>
        </SettingsTable>

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
