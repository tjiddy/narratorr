// Does not use useSettingsForm: theme is stored in localStorage via useTheme, not the settings API.
import { SunIcon } from '@/components/icons';
import { ToggleSwitch } from '@/components/settings/ToggleSwitch';
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
      <div className="flex items-center justify-between">
        <div>
          <label htmlFor="darkMode" className="block text-sm font-medium">
            Dark Mode
          </label>
          <p className="text-sm text-muted-foreground mt-0.5">
            Switch between light and dark theme
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <ToggleSwitch
            id="darkMode"
            checked={theme === 'dark'}
            onChange={toggleTheme}
            aria-label="Dark Mode"
          />
        </label>
      </div>
    </SettingsSection>
  );
}
