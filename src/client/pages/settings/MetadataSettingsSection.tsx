import { useState } from 'react';
import { useWatch } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { BookOpenIcon } from '@/components/icons';
import { TestButton } from '@/components/TestButton';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { audibleRegionSchema, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

const REGION_LABELS: Record<string, string> = {
  us: 'United States',
  ca: 'Canada',
  uk: 'United Kingdom',
  au: 'Australia',
  fr: 'France',
  de: 'Germany',
  jp: 'Japan',
  it: 'Italy',
  in: 'India',
  es: 'Spain',
};

const metadataFormSchema = z.object({
  audibleRegion: audibleRegionSchema,
  hardcoverApiKey: z.string(),
});

type MetadataFormData = z.infer<typeof metadataFormSchema>;

function toFormData(settings: AppSettings): MetadataFormData {
  return {
    audibleRegion: settings.metadata.audibleRegion,
    hardcoverApiKey: settings.metadata.hardcoverApiKey,
  };
}

function toPayload(data: MetadataFormData) {
  return {
    metadata: {
      audibleRegion: data.audibleRegion,
      hardcoverApiKey: data.hardcoverApiKey,
    },
  };
}

export function MetadataSettingsSection() {
  const { form, mutation, onSubmit } = useSettingsForm<MetadataFormData>({
    schema: metadataFormSchema,
    defaultValues: toFormData({ ...DEFAULT_SETTINGS } as AppSettings),
    select: toFormData,
    toPayload,
    successMessage: 'Metadata settings saved',
  });

  const { register, handleSubmit, control, formState: { isDirty } } = form;
  const [testing, setTesting] = useState(false);

  const hardcoverApiKey = useWatch({ control, name: 'hardcoverApiKey' }) ?? '';
  const canTest = hardcoverApiKey.trim().length > 0;

  async function handleTest() {
    setTesting(true);
    try {
      const result = await api.testHardcoverApiKey(hardcoverApiKey);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setTesting(false);
    }
  }

  return (
    <SettingsSection
      icon={<BookOpenIcon className="w-5 h-5 text-primary" />}
      title="Metadata"
      description="Configure metadata providers for book details and series info."
    >
      <form onSubmit={handleSubmit((data) => onSubmit(data))} className="space-y-5">
        <div>
          <label htmlFor="audibleRegion" className="block text-sm font-medium mb-2">Region</label>
          <SelectWithChevron id="audibleRegion" {...register('audibleRegion')}>
            {audibleRegionSchema.options.map((region) => (
              <option key={region} value={region}>
                {REGION_LABELS[region] ?? region}
              </option>
            ))}
          </SelectWithChevron>
          <p className="text-sm text-muted-foreground mt-2">
            Select your Audible region for metadata lookups. Affects which catalog is searched for audiobook details, narrators, and cover art.
          </p>
        </div>

        <div>
          <label htmlFor="hardcoverApiKey" className="block text-sm font-medium mb-2">Hardcover API Key</label>
          <div className="flex gap-2">
            <input
              id="hardcoverApiKey"
              type="password"
              autoComplete="off"
              {...register('hardcoverApiKey')}
              className="flex-1 px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all"
              placeholder="Paste your Hardcover API key"
            />
            <TestButton
              testing={testing}
              onClick={handleTest}
              variant="form"
              disabled={!canTest}
            />
          </div>
          <p className="text-sm text-muted-foreground mt-2">
            Used to populate the Series card with Hardcover-canonical members. Leave blank to show only books from your library that share the series name.
          </p>
        </div>

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
