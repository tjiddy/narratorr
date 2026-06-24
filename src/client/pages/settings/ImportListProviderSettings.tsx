import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { compactInputClass as inputClass } from '@/components/settings/formStyles';

interface SettingsProps {
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
}

function NytSettings({ settings, onChange }: SettingsProps) {
  return (
    <>
      <div>
        <label htmlFor="nyt-apiKey" className="block text-sm font-medium mb-1">API Key</label>
        <input
          id="nyt-apiKey"
          type="password"
          value={(settings.apiKey as string) ?? ''}
          onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          className={inputClass}
          placeholder="API key is required"
        />
      </div>
      <div>
        <label htmlFor="nyt-list" className="block text-sm font-medium mb-1">Bestseller List</label>
        <SelectWithChevron
          id="nyt-list"
          value={(settings.list as string) ?? 'audio-fiction'}
          onChange={(e) => onChange({ ...settings, list: e.target.value })}
        >
          <option value="audio-fiction">Audio Fiction</option>
          <option value="audio-nonfiction">Audio Nonfiction</option>
        </SelectWithChevron>
      </div>
    </>
  );
}

function HardcoverSettings({ settings, onChange }: SettingsProps) {
  const listType = (settings.listType as string) ?? 'trending';

  return (
    <>
      <div>
        <label htmlFor="hc-apiKey" className="block text-sm font-medium mb-1">API Key</label>
        <input
          id="hc-apiKey"
          type="password"
          value={(settings.apiKey as string) ?? ''}
          onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          className={inputClass}
          placeholder="API key is required"
        />
      </div>
      <div>
        <label htmlFor="hc-listType" className="block text-sm font-medium mb-1">List Type</label>
        <SelectWithChevron
          id="hc-listType"
          value={listType}
          onChange={(e) => onChange({ ...settings, listType: e.target.value })}
        >
          <option value="trending">Trending</option>
          <option value="shelf">Shelf</option>
        </SelectWithChevron>
      </div>
      {listType === 'shelf' && (
        <div>
          <label htmlFor="hc-shelfId" className="block text-sm font-medium mb-1">Shelf ID</label>
          <input
            id="hc-shelfId"
            type="number"
            min={1}
            step={1}
            value={(settings.shelfId as number | undefined) ?? ''}
            onChange={(e) => {
              const next = { ...settings };
              const n = e.target.valueAsNumber;
              if (Number.isFinite(n)) next.shelfId = n;
              else delete next.shelfId;
              onChange(next);
            }}
            className={inputClass}
            placeholder="Your Hardcover shelf ID"
          />
        </div>
      )}
    </>
  );
}

export function ProviderSettings({
  type,
  settings,
  onChange,
}: {
  type: string;
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
}) {
  switch (type) {
    case 'nyt': return <NytSettings settings={settings} onChange={onChange} />;
    case 'hardcover': return <HardcoverSettings settings={settings} onChange={onChange} />;
    default: return null;
  }
}
