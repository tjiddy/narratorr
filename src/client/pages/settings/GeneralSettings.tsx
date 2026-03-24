import { LibrarySettingsSection } from './LibrarySettingsSection';
import { SearchSettingsSection } from './SearchSettingsSection';
import { ImportSettingsSection } from './ImportSettingsSection';
import { QualitySettingsSection } from './QualitySettingsSection';
import { NetworkSettingsSection } from './NetworkSettingsSection';
import { MetadataSettingsForm } from './MetadataSettingsForm';
import { DiscoverySettingsSection } from '../discover/DiscoverySettingsSection';

export function GeneralSettings() {
  return (
    <div className="space-y-8">
      <LibrarySettingsSection />
      <SearchSettingsSection />
      <ImportSettingsSection />
      <QualitySettingsSection />
      <NetworkSettingsSection />
      <DiscoverySettingsSection />
      <MetadataSettingsForm />
    </div>
  );
}
