import { useState } from 'react';
import { api } from '@/lib/api';
import { SelectWithChevron } from '@/components/settings/SelectWithChevron';
import { compactInputClass as inputClass, btnSecondary } from '@/components/settings/formStyles';

interface SettingsProps {
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
  /** id of the import list being edited, if any — forwarded so the route can
   *  resolve a masked apiKey against the persisted record. */
  editingId?: number;
}

function AbsSettings({ settings, onChange, editingId }: SettingsProps) {
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string }>>([]);
  const [fetchError, setFetchError] = useState('');
  const [fetching, setFetching] = useState(false);

  async function handleFetchLibraries() {
    const serverUrl = settings.serverUrl as string;
    const apiKey = settings.apiKey as string;
    if (!serverUrl || !apiKey) {
      setFetchError('Enter server URL and API key first');
      return;
    }
    setFetching(true);
    setFetchError('');
    try {
      const result = await api.fetchAbsLibraries({
        serverUrl,
        apiKey,
        ...(editingId !== undefined ? { id: editingId } : {}),
      });
      setLibraries(result.libraries);
      if (result.libraries.length === 0) setFetchError('No libraries found');
    } catch {
      setFetchError('Failed to fetch libraries');
    } finally {
      setFetching(false);
    }
  }

  return (
    <>
      <div>
        <label htmlFor="abs-serverUrl" className="block text-sm font-medium mb-1">Server URL</label>
        <input
          id="abs-serverUrl"
          type="text"
          value={(settings.serverUrl as string) ?? ''}
          onChange={(e) => onChange({ ...settings, serverUrl: e.target.value })}
          className={inputClass}
          placeholder="http://audiobookshelf.local:13378"
        />
      </div>
      <div>
        <label htmlFor="abs-apiKey" className="block text-sm font-medium mb-1">API Key</label>
        <input
          id="abs-apiKey"
          type="password"
          value={(settings.apiKey as string) ?? ''}
          onChange={(e) => onChange({ ...settings, apiKey: e.target.value })}
          className={inputClass}
          placeholder="API key is required"
        />
      </div>
      <div>
        <label htmlFor="abs-libraryId" className="block text-sm font-medium mb-1">Library</label>
        <div className="flex gap-2">
          {libraries.length > 0 ? (
            <SelectWithChevron
              id="abs-libraryId"
              value={(settings.libraryId as string) ?? ''}
              onChange={(e) => onChange({ ...settings, libraryId: e.target.value })}
            >
              <option value="">Select a library...</option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>{lib.name}</option>
              ))}
            </SelectWithChevron>
          ) : (
            <input
              id="abs-libraryId"
              type="text"
              value={(settings.libraryId as string) ?? ''}
              onChange={(e) => onChange({ ...settings, libraryId: e.target.value })}
              className={inputClass}
              placeholder="Library ID (or fetch libraries)"
            />
          )}
          <button
            type="button"
            onClick={handleFetchLibraries}
            disabled={fetching}
            className={`${btnSecondary} bg-muted hover:bg-muted/80 whitespace-nowrap`}
          >
            {fetching ? 'Fetching...' : 'Fetch Libraries'}
          </button>
        </div>
        {fetchError && <p className="text-sm text-destructive mt-1">{fetchError}</p>}
      </div>
    </>
  );
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
  editingId,
}: {
  type: string;
  settings: Record<string, unknown>;
  onChange: (settings: Record<string, unknown>) => void;
  editingId?: number | undefined;
}) {
  switch (type) {
    case 'abs': return <AbsSettings settings={settings} onChange={onChange} editingId={editingId} />;
    case 'nyt': return <NytSettings settings={settings} onChange={onChange} />;
    case 'hardcover': return <HardcoverSettings settings={settings} onChange={onChange} />;
    default: return null;
  }
}
