import type { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpenIcon } from '@/components/icons';
import { InfoTip } from '@/components/settings/InfoTip';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useSettingsForm } from '@/hooks/useSettingsForm';
import { DEFAULT_SETTINGS, companionEpubFormSchema, type AppSettings } from '../../../shared/schemas.js';
import { SettingsSection } from './SettingsSection';

type EbooksFormData = z.infer<typeof companionEpubFormSchema>;

function pickFormFields(src: typeof DEFAULT_SETTINGS.companionEpub): EbooksFormData {
  return { enabled: src.enabled };
}

// Single source of truth for the card name: shared by the guard label and the SettingsSection title.
const CARD_LABEL = 'Ebooks';

// The external-doc-link styling owned by HealthDashboard.tsx — adopted verbatim, not re-authored.
const DOC_LINK_CLASS =
  'inline-block text-xs font-medium mt-1 text-primary hover:text-primary/80 underline decoration-primary/30 underline-offset-2 hover:decoration-primary/60 transition-colors';

/**
 * The owner-facing toggle for the ebook feature (#1958). The registry key is `companionEpub`
 * — internal vocabulary that reaches the API response and the form payload but never a
 * rendered label. Nothing this section renders says "companion", and no string it owns
 * carries an em-dash (plan §7 copy rules), including accessible names: the `InfoTip` keeps
 * its own default `More info` label rather than taking a feature-specific override.
 */
export function EbooksSettingsSection() {
  const queryClient = useQueryClient();
  const { form, mutation } = useSettingsForm<EbooksFormData>({
    schema: companionEpubFormSchema,
    defaultValues: pickFormFields(DEFAULT_SETTINGS.companionEpub),
    select: (s: AppSettings) => pickFormFields(s.companionEpub),
    toPayload: (d) => ({ companionEpub: d }),
    successMessage: 'Ebook settings saved',
    label: CARD_LABEL,
  });

  const { register, handleSubmit, formState: { isDirty } } = form;

  /**
   * Turning the feature off must also drop every cached Ebook-panel observation (#1963 AC2),
   * or a book page rendered before the flip could keep an `Available` pill and a download link
   * alive from cache. Evicted on ANY successful save, in both directions, so there is no
   * direction branching to get wrong.
   *
   * The seam is `mutation.mutate(data, { onSuccess })` at the call site rather than the hook's
   * `onSubmit(data)` — `useSettingsForm` is shared and stays untouched. Call-site callbacks are
   * skipped if the page unmounts mid-save (`react-query-mutation-callbacks-post-unmount`);
   * that is acceptable because this is polish, not the correctness guarantee. The panel's own
   * `409` rule plus its retry predicate holds the invariant, so a skipped eviction degrades to
   * one brief render before the refetch `409`s, never to a persistent panel.
   */
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
      <form
        onSubmit={handleSubmit((data) => mutation.mutate(data, { onSuccess: evictCompanionEbookCache }))}
        className="space-y-5"
      >
        <SettingsTable>
          {/* "Enable ebook support", not bare "Ebooks" — the section title is already "Ebooks"
              and a same-text row label would break every getByText('Ebooks') query. */}
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
    </SettingsSection>
  );
}
