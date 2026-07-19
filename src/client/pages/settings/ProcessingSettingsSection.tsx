import { type ReactNode } from 'react';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { ZapIcon, AlertTriangleIcon, TerminalIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { NumberField } from '@/components/settings/NumberField';
import { InfoTip } from '@/components/settings/InfoTip';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { TAG_MODE_LABELS } from '@/lib/constants';
import { tagModeSchema, postProcessingScriptTimeoutField, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { useFfmpegStatus } from '@/hooks/useFfmpegStatus';

const saveButtonClass = 'px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in';

// Post Processing = the "when": automations that fire after a download. The merge/convert
// ENGINE config (the "how") lives on the Audio Tools page. TWO independent forms — one per card,
// each with its own dirty-gated Save (the app-wide per-card convention). Each saves only its own
// subset; the backend patch-merges categories, so the two forms (and the Audio Tools engine
// subset) never clobber each other.

// ─── Automations card (processing automations + the whole tagging category) ───

const automationsFormSchema = z.object({
  autoMergeDownloads: z.boolean(),
  taggingEnabled: z.boolean(),
  tagMode: tagModeSchema,
  embedCover: z.boolean(),
  writeOpf: z.boolean(),
});

type AutomationsFormData = z.infer<typeof automationsFormSchema>;

function toAutomationsFormData(settings: AppSettings): AutomationsFormData {
  return {
    autoMergeDownloads: settings.processing.autoMergeDownloads,
    taggingEnabled: settings.tagging.enabled,
    tagMode: settings.tagging.mode,
    embedCover: settings.tagging.embedCover,
    writeOpf: settings.tagging.writeOpf,
  };
}

function toAutomationsPayload(data: AutomationsFormData) {
  return {
    processing: {
      autoMergeDownloads: data.autoMergeDownloads,
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

// Single source of truth for the card name: shared by the guard label and the SettingsSection title.
const POST_PROCESSING_CARD_LABEL = 'Post Processing';

function AutomationsForm() {
  const ffmpegStatus = useFfmpegStatus();
  // Optimistic while the status query LOADS — avoids a flash of "needs ffmpeg" on a
  // normal (ffmpeg-present) install — but fail SAFE on a query error: an errored status
  // fetch gates the toggles (disabled) rather than leaving them enabled on a box where
  // ffmpeg may be absent. Real enforcement is still the backend FFMPEG_NOT_CONFIGURED gate.
  const ffmpegAvailable = ffmpegStatus.isError ? false : ffmpegStatus.data?.detected !== false;

  const { form, mutation, onSubmit } = useSettingsForm<AutomationsFormData>({
    schema: automationsFormSchema,
    defaultValues: toAutomationsFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toAutomationsFormData,
    toPayload: toAutomationsPayload,
    successMessage: 'Post processing settings saved',
    label: POST_PROCESSING_CARD_LABEL,
  });

  const { register, handleSubmit, watch, formState: { isDirty } } = form;
  const taggingEnabled = watch('taggingEnabled');
  const autoMergeDownloads = watch('autoMergeDownloads');

  return (
    <SettingsSection
      icon={<ZapIcon className="w-5 h-5 text-primary" />}
      title={POST_PROCESSING_CARD_LABEL}
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
            description={
              <>
                Write a <code className="px-1 py-0.5 bg-muted rounded text-xs">metadata.opf</code> into each book folder on import.{' '}
                <InfoTip label="Audiobookshelf setup">
                  Using Audiobookshelf? Enable this, then turn on “Prefer OPF metadata” in your ABS
                  library settings so it reads the sidecar instead of the audio file’s tags.
                </InfoTip>
              </>
            }
          >
            <ToggleSwitch id="writeOpf" {...register('writeOpf')} />
          </SettingsRow>
        </SettingsTable>

        {isDirty && (
          <button type="submit" disabled={mutation.isPending} className={saveButtonClass}>
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
        )}
      </form>
    </SettingsSection>
  );
}

// ─── Custom script card (script path + timeout — its own form and Save) ───

const customScriptFormSchema = z.object({
  postProcessingScript: z.string(),
  postProcessingScriptTimeout: postProcessingScriptTimeoutField.optional(),
}).superRefine((data, ctx) => {
  if (data.postProcessingScript?.trim() && data.postProcessingScriptTimeout == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['postProcessingScriptTimeout'],
      message: 'Timeout is required when a post-processing script is configured',
    });
  }
});

type CustomScriptFormData = z.infer<typeof customScriptFormSchema>;

function toCustomScriptFormData(settings: AppSettings): CustomScriptFormData {
  return {
    postProcessingScript: settings.processing.postProcessingScript,
    postProcessingScriptTimeout: settings.processing.postProcessingScriptTimeout,
  };
}

function toCustomScriptPayload(data: CustomScriptFormData) {
  return {
    processing: {
      postProcessingScript: data.postProcessingScript,
      ...(data.postProcessingScriptTimeout !== undefined && { postProcessingScriptTimeout: data.postProcessingScriptTimeout }),
    },
  };
}

/** A monospaced env-var chip for the script's description copy. */
function EnvChip({ children }: { children: ReactNode }) {
  return <code className="px-1 py-0.5 bg-muted rounded text-xs font-mono">{children}</code>;
}

// Single source of truth for the card name: shared by the guard label and the SettingsSection title.
const CUSTOM_SCRIPT_CARD_LABEL = 'Custom script';

function CustomScriptForm() {
  const { form, mutation, onSubmit } = useSettingsForm<CustomScriptFormData>({
    schema: customScriptFormSchema,
    defaultValues: toCustomScriptFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toCustomScriptFormData,
    toPayload: toCustomScriptPayload,
    successMessage: 'Custom script settings saved',
    label: CUSTOM_SCRIPT_CARD_LABEL,
  });

  const { register, handleSubmit, formState: { errors, isDirty } } = form;

  return (
    <SettingsSection
      icon={<TerminalIcon className="w-5 h-5 text-primary" />}
      title={CUSTOM_SCRIPT_CARD_LABEL}
      description="Run a script after each successful import — hand off to another tool, or run ffmpeg and other transforms on every downloaded book."
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <SettingsTable>
          <SettingsRow
            layout="stacked"
            htmlFor="postProcessingScript"
            label="Post-processing script"
            description={
              <>
                Absolute path to the script. Leave empty to disable.{' '}
                <InfoTip label="Script environment variables">
                  <span className="block mb-1.5">The script runs with these environment variables set:</span>
                  <span className="block space-y-1">
                    <span className="block"><EnvChip>NARRATORR_BOOK_TITLE</EnvChip></span>
                    <span className="block"><EnvChip>NARRATORR_BOOK_AUTHOR</EnvChip></span>
                    <span className="block"><EnvChip>NARRATORR_IMPORT_PATH</EnvChip></span>
                    <span className="block"><EnvChip>NARRATORR_IMPORT_FILE_COUNT</EnvChip></span>
                  </span>
                </InfoTip>
              </>
            }
          >
            <input
              id="postProcessingScript"
              type="text"
              {...register('postProcessingScript')}
              placeholder="/path/to/script.sh"
              className={errorInputClass(!!errors.postProcessingScript)}
            />
            {errors.postProcessingScript && <span className="block mt-1 text-xs text-destructive">{errors.postProcessingScript.message}</span>}
          </SettingsRow>

          <SettingsRow
            htmlFor="postProcessingScriptTimeout"
            label="Script timeout"
            description="Maximum time before the script is killed. Default: 300 (5 minutes)."
          >
            <NumberField
              id="postProcessingScriptTimeout"
              {...register('postProcessingScriptTimeout', { setValueAs: (v: string) => { const n = Number(v); return v === '' || Number.isNaN(n) ? undefined : n; } })}
              min={1}
              step={1}
              placeholder="300"
              suffix="seconds"
              error={errors.postProcessingScriptTimeout?.message}
            />
          </SettingsRow>
        </SettingsTable>

        {isDirty && (
          <button type="submit" disabled={mutation.isPending} className={saveButtonClass}>
            {mutation.isPending ? 'Saving...' : 'Save'}
          </button>
        )}
      </form>
    </SettingsSection>
  );
}

export function ProcessingSettingsSection() {
  return (
    <div className="space-y-8">
      <AutomationsForm />
      <CustomScriptForm />
    </div>
  );
}
