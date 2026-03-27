import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { LibrarySettingsSection } from './LibrarySettingsSection';
import { SearchSettingsSection } from './SearchSettingsSection';
import { ImportSettingsSection } from './ImportSettingsSection';
import { QualitySettingsSection } from './QualitySettingsSection';
import { NetworkSettingsSection } from './NetworkSettingsSection';
import { MetadataSettingsForm } from './MetadataSettingsForm';
import { AppearanceSettingsSection } from './AppearanceSettingsSection';
import { DiscoverySettingsSection } from '../discover/DiscoverySettingsSection';
import { SettingsSection } from './SettingsSection';

function EyeIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function GeneralSettings() {
  const queryClient = useQueryClient();

  const resetWelcomeMutation = useMutation({
    mutationFn: () => api.updateSettings({ general: { welcomeSeen: false } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      toast.success('Welcome message will appear on next view');
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to reset welcome message');
    },
  });

  return (
    <div className="space-y-8">
      <LibrarySettingsSection />
      <SearchSettingsSection />
      <ImportSettingsSection />
      <QualitySettingsSection />
      <NetworkSettingsSection />
      <DiscoverySettingsSection />
      <MetadataSettingsForm />
      <AppearanceSettingsSection />
      <SettingsSection
        icon={<EyeIcon className="w-5 h-5 text-primary" />}
        title="Onboarding"
        description="Re-display the welcome modal"
      >
        <p className="text-sm text-muted-foreground">
          Show the welcome modal again to review key defaults and feature highlights.
        </p>
        <button
          type="button"
          onClick={() => resetWelcomeMutation.mutate()}
          disabled={resetWelcomeMutation.isPending}
          className="px-4 py-2.5 border border-border font-medium rounded-xl hover:bg-muted disabled:opacity-50 transition-all text-sm focus-ring"
        >
          {resetWelcomeMutation.isPending ? 'Saving...' : 'Show Welcome Message'}
        </button>
      </SettingsSection>
    </div>
  );
}
