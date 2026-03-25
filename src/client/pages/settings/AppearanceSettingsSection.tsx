import { SunIcon } from '@/components/icons';
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
          <input
            id="darkMode"
            type="checkbox"
            checked={theme === 'dark'}
            onChange={toggleTheme}
            className="sr-only peer"
            aria-label="Dark Mode"
          />
          <div className="w-11 h-6 bg-muted rounded-full peer peer-checked:bg-primary transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:after:translate-x-full" />
        </label>
      </div>
    </SettingsSection>
  );
}
