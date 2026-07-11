import { useState } from 'react';
import { LibrarySettingsSection } from './LibrarySettingsSection';
import { NamingSettingsSection } from './NamingSettingsSection';
import { ImportSettingsSection } from './ImportSettingsSection';
import { NetworkSettingsSection } from './NetworkSettingsSection';
import { AppearanceSettingsSection } from './AppearanceSettingsSection';
import { DiscoverySettingsSection } from '../discover/DiscoverySettingsSection';
import { SettingsSection } from './SettingsSection';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { WelcomeModal } from '@/components/WelcomeModal';

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
  const [showWelcome, setShowWelcome] = useState(false);

  return (
    <div className="space-y-8">
      <LibrarySettingsSection />
      <NamingSettingsSection />
      <ImportSettingsSection />
      <NetworkSettingsSection />
      <DiscoverySettingsSection />
      <AppearanceSettingsSection />
      <SettingsSection
        icon={<EyeIcon className="w-5 h-5 text-primary" />}
        title="Onboarding"
        description="Re-display the welcome modal"
      >
        <SettingsTable>
          <SettingsRow label="Welcome tour" description="Review key defaults and feature highlights.">
            <button
              type="button"
              onClick={() => setShowWelcome(true)}
              className="px-4 py-2.5 border border-border font-medium rounded-xl hover:bg-muted disabled:opacity-50 transition-all text-sm focus-ring"
            >
              Show welcome message
            </button>
          </SettingsRow>
        </SettingsTable>
      </SettingsSection>
      <WelcomeModal isOpen={showWelcome} onDismiss={() => setShowWelcome(false)} />
    </div>
  );
}
