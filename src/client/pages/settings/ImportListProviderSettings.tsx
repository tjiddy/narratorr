import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { compactInputClass as inputClass } from '@/components/settings/formStyles';
import { parseHardcoverListUrl } from '../../../shared/hardcover-list-url.js';

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
  const listUrl = (settings.listUrl as string) ?? '';
  const importMax = settings.importMax === 'all' ? 'all' : String((settings.importMax as number | undefined) ?? 50);

  // Advisory local feedback only (the server schema + test() are authoritative,
  // #1879 AC13): a non-empty listUrl that fails to parse renders inline; empty
  // and parseable values clear it.
  const urlError = listUrl.trim() !== '' && parseHardcoverListUrl(listUrl) === null
    ? 'Not a Hardcover list URL'
    : null;

  // Dedicated list-type change handler (AC12): preserve apiKey + only the target
  // type's own keys, deleting every foreign key — listUrl/importMax when leaving
  // custom, shelfId when entering custom or trending. Replaces the bare
  // `onChange({ ...settings, listType })` so no stale foreign key survives.
  function handleListTypeChange(next: string) {
    const scoped: Record<string, unknown> = { ...settings, listType: next };
    if (next !== 'custom') { delete scoped.listUrl; delete scoped.importMax; }
    if (next !== 'shelf') { delete scoped.shelfId; }
    onChange(scoped);
  }

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
          onChange={(e) => handleListTypeChange(e.target.value)}
        >
          <option value="trending">Trending</option>
          <option value="shelf">Shelf</option>
          <option value="custom">Custom List (by URL)</option>
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
      {listType === 'custom' && (
        <>
          <div>
            <label htmlFor="hc-listUrl" className="block text-sm font-medium mb-1">List URL</label>
            <input
              id="hc-listUrl"
              type="text"
              value={listUrl}
              onChange={(e) => onChange({ ...settings, listUrl: e.target.value })}
              className={inputClass}
              placeholder="https://hardcover.app/@username/lists/list-slug"
            />
            {urlError && <p className="mt-1 text-sm text-destructive">{urlError}</p>}
          </div>
          <div>
            <label htmlFor="hc-importMax" className="block text-sm font-medium mb-1">Import Max</label>
            <SelectWithChevron
              id="hc-importMax"
              value={importMax}
              onChange={(e) => {
                const v = e.target.value;
                onChange({ ...settings, importMax: v === 'all' ? 'all' : Number(v) });
              }}
            >
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="all">All</option>
            </SelectWithChevron>
          </div>
        </>
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
