import type { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon } from '@/components/icons';
import { InfoTip } from '@/components/settings/InfoTip';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, companionEpubFormSchema, type AppSettings } from '@shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type EbooksFormData = z.infer<typeof companionEpubFormSchema>;

function pickFormFields(src: typeof DEFAULT_SETTINGS.companionEpub): EbooksFormData {
  return { enabled: src.enabled };
}

// Guard label and section title must stay identical.
const CARD_LABEL = 'Ebooks';

// Shared verbatim with HealthDashboard external links.
const DOC_LINK_CLASS =
  'inline-block text-xs font-medium mt-1 text-primary hover:text-primary/80 underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 transition-colors';

// `companionEpub` is an API key; owner-facing copy uses “ebook” only.
export function EbooksSettingsSection() {
  const queryClient = useQueryClient();
  const { form, mutation, settingsError, refetchSettings } = useSettingsForm<EbooksFormData>({
    schema: companionEpubFormSchema,
    defaultValues: pickFormFields(DEFAULT_SETTINGS.companionEpub),
    select: (s: AppSettings) => pickFormFields(s.companionEpub),
    toPayload: (d) => ({ companionEpub: d }),
    successMessage: 'Ebook settings saved',
    label: CARD_LABEL,
  });

  const { register, handleSubmit, formState: { isDirty } } = form;

  // Every successful save evicts companion-ebook observations to prevent stale book-page availability.
  const evictCompanionEbookCache = () => {
    queryClient.removeQueries({
      predicate: (query) => query.queryKey[0] === 'books' && query.queryKey[2] === 'companion-epub',
    });
  };

  return (
    <SettingsSection
      icon={<BookOpenIcon className="w-5 h-5 text-primary" />}
      title={CARD_LABEL}
      description="Show ebooks you've stored alongside your audiobooks."
    >
      {/* An unchecked toggle reads as "ebook support is off" — but that is the schema default,
          and a failed read never observed the saved value. Replace the form rather than
          rendering a control whose position is a guess. */}
      {settingsError ? (
        <div className="flex items-center gap-3">
          <p className="text-sm text-red-500">Failed to load ebook settings.</p>
          <button
            type="button"
            onClick={refetchSettings}
            aria-label="Retry loading ebook settings"
            className="px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      ) : (
        <form
          onSubmit={handleSubmit((data) => mutation.mutate(data, { onSuccess: evictCompanionEbookCache }))}
          className="space-y-5"
        >
          <SettingsTable>
            <SettingsRow
              htmlFor="companion-epub-enabled"
              label="Enable ebook support"
              description={
                <>
                  Show ebooks stored alongside your audiobooks, ready to download from the book page.{' '}
                  <InfoTip>
                    Ebooks need to already be in the book&apos;s folder. Narratorr doesn&apos;t search for or
                    download them. Enabling this also exposes them over the API, which is how{' '}
                    <a
                      href="https://docs.narratorr.dev/narratorr-requests/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={DOC_LINK_CLASS}
                    >
                      Narratorr Requests
                    </a>
                    {' '}offers Download and Send to Kindle to your family.
                  </InfoTip>
                </>
              }
            >
              <ToggleSwitch id="companion-epub-enabled" {...register('enabled')} />
            </SettingsRow>
          </SettingsTable>

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
