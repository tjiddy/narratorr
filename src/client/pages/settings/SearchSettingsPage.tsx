import { SearchSettingsSection } from './SearchSettingsSection';
import { FilteringSettingsSection } from './FilteringSettingsSection';
import { QualitySettingsSection } from './QualitySettingsSection';

export function SearchSettingsPage() {
  return (
    <div className="space-y-8">
      <SearchSettingsSection />
      <FilteringSettingsSection />
      <QualitySettingsSection />
    </div>
  );
}
