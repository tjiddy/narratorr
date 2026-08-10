import { type ReactNode } from 'react';
import type { UseFormRegister } from 'react-hook-form';
import { z } from 'zod';
import { Link } from 'react-router';
import { ZapIcon, AlertTriangleIcon, TerminalIcon } from '@/components/icons';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { NumberField } from '@/components/settings/NumberField';
import { InfoTip } from '@/components/settings/InfoTip';
import { errorInputClass } from '@/components/settings/formStyles';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { TAG_MODE_LABELS } from '@/lib/constants';
import { tagModeSchema, postProcessingScriptTimeoutField, DEFAULT_SETTINGS, type AppSettings } from '@shared/schemas.js';
import { SettingsSection } from './SettingsSection';
import { useFfmpegStatus } from '@/hooks/useFfmpegStatus';
import { useMutagenStatus } from '@/hooks/useMutagenStatus';

const saveButtonClass = 'px-4 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all text-sm focus-ring animate-fade-in';

// Post Processing owns automation; Audio Tools owns merge/convert. These cards submit disjoint
// subsets that the backend patch-merges, so each retains an independent dirty-gated Save.

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

function GateNote() {
  return (
    <span className="inline-flex items-center gap-1.5 mt-2 text-xs font-medium text-destructive">
      <AlertTriangleIcon className="w-3.5 h-3.5" />
      ffmpeg not found —{' '}
      <Link to="/settings/audio-tools" className="underline underline-offset-2">see ffmpeg requirements in Audio Tools</Link>
    </span>
  );
}

function MutagenGateNote() {
  return (
    <span className="inline-flex items-center gap-1.5 mt-2 text-xs font-medium text-destructive">
      <AlertTriangleIcon className="w-3.5 h-3.5" />
      mutagen not found — install Python with the mutagen module, or set MUTAGEN_PYTHON
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

const POST_PROCESSING_CARD_LABEL = 'Post Processing';

function CapabilityPill({ label }: { label: string }) {
  return (
    <span className="ml-1 text-[0.65rem] uppercase tracking-wide text-muted-foreground border border-border rounded-full px-1.5 py-0.5">
      {label}
    </span>
  );
}

/**
 * Tag embedding gates on mutagen while auto-merge stays on ffmpeg, so this owns its own capability
 * query: after #2210 the two rows in this card legitimately report different binaries.
 */
function TagEmbeddingRows({ register, taggingEnabled }: {
  register: UseFormRegister<AutomationsFormData>;
  taggingEnabled: boolean;
}) {
  const mutagenStatus = useMutagenStatus();
  // Stay optimistic while loading to avoid a false warning, but fail closed on query errors.
  // The backend still enforces MUTAGEN_NOT_CONFIGURED.
  const available = mutagenStatus.isError ? false : mutagenStatus.data?.detected !== false;

  return (
    <>
      <SettingsRow
        htmlFor="taggingEnabled"
        label={<>Tag Embedding {!available && <CapabilityPill label="needs mutagen" />}</>}
        description={<>Write book metadata into the audio file’s tags on import. Series, series part, subtitle, ASIN, and publisher are written into the file on both MP3 and M4B.{!available && <MutagenGateNote />}</>}
        muted={!available}
      >
        <ToggleSwitch id="taggingEnabled" disabled={!available && !taggingEnabled} {...register('taggingEnabled')} />
      </SettingsRow>

      {taggingEnabled && available && (
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

      {taggingEnabled && available && (
        <SettingsRow htmlFor="embedCover" label="Embed cover art" description="Embed the book’s cover image into audio file tags.">
          <ToggleSwitch id="embedCover" {...register('embedCover')} />
        </SettingsRow>
      )}
    </>
  );
}

function AutomationsForm() {
  const ffmpegStatus = useFfmpegStatus();
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
            label={<>Auto-merge multi-file downloads {!ffmpegAvailable && <CapabilityPill label="needs ffmpeg" />}</>}
            description={<AutoMergeDescription gated={!ffmpegAvailable} />}
            muted={!ffmpegAvailable}
          >
            <ToggleSwitch id="autoMergeDownloads" disabled={!ffmpegAvailable && !autoMergeDownloads} {...register('autoMergeDownloads')} />
          </SettingsRow>

          <TagEmbeddingRows register={register} taggingEnabled={taggingEnabled} />

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

function EnvChip({ children }: { children: ReactNode }) {
  return <code className="px-1 py-0.5 bg-muted rounded text-xs font-mono">{children}</code>;
}

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
