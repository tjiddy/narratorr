import { NewBookDefaultsSection } from './NewBookDefaultsSection';
import { SearchSettingsSection } from './SearchSettingsSection';
import { MetadataSettingsSection } from './MetadataSettingsSection';
import { FilteringSettingsSection } from './FilteringSettingsSection';
import { QualitySettingsSection } from './QualitySettingsSection';

export function SearchSettingsPage() {
  return (
    <div className="space-y-8">
      <NewBookDefaultsSection />
      <SearchSettingsSection />
      <MetadataSettingsSection />
      <FilteringSettingsSection />
      <QualitySettingsSection />
    </div>
  );
}
