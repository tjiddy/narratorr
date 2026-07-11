// Does not use useSettingsForm: theme is stored in localStorage via useTheme, not the settings API.
import { SunIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
import { SettingsRow, SettingsTable } from '@/components/settings/SettingsRow';
import { useTheme } from '@/hooks/useTheme';
import { SettingsSection } from './SettingsSection';

export function AppearanceSettingsSection() {
  const { theme, toggleTheme } = useTheme();

  return (
    <SettingsSection
      icon={<SunIcon className="w-5 h-5 text-primary" />}
      title="Appearance"
      description="Customize the look and feel of the application"
    >
      <SettingsTable>
        <SettingsRow htmlFor="darkMode" label="Dark mode" description="Switch between light and dark theme">
          <ToggleSwitch
            id="darkMode"
            checked={theme === 'dark'}
            onChange={toggleTheme}
            aria-label="Dark mode"
          />
        </SettingsRow>
      </SettingsTable>
    </SettingsSection>
  );
}
