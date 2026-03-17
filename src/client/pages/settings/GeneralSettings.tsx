import { LibrarySettingsSection } from './LibrarySettingsSection';
import { SearchSettingsSection } from './SearchSettingsSection';
import { ImportSettingsSection } from './ImportSettingsSection';
import { QualitySettingsSection } from './QualitySettingsSection';
import { ProcessingSettingsSection } from './ProcessingSettingsSection';
import { NetworkSettingsSection } from './NetworkSettingsSection';
import { GeneralSettingsForm } from './GeneralSettingsForm';
import { MetadataSettingsForm } from './MetadataSettingsForm';
import { DiscoverySettingsSection } from '../discover/DiscoverySettingsSection';

export function GeneralSettings() {
  return (
    <div className="space-y-8">
      <LibrarySettingsSection />
      <SearchSettingsSection />
      <ImportSettingsSection />
      <QualitySettingsSection />
      <ProcessingSettingsSection />
      <NetworkSettingsSection />
      <DiscoverySettingsSection />
      <GeneralSettingsForm />
      <MetadataSettingsForm />
    </div>
  );
}
