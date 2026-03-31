import { useState, useCallback } from 'react';
import { PlusIcon, XIcon, ArrowRightIcon, FolderIcon } from '@/components/icons';

export interface PathMappingEntry {
  remotePath: string;
  localPath: string;
}

interface PathMappingEditorProps {
  mappings: PathMappingEntry[];
  onChange: (mappings: PathMappingEntry[]) => void;
}

/**
 * Local-state path mapping editor for create mode.
 * Unlike RemotePathMappingsSubsection (edit mode, API-backed), this component
 * manages mappings as local state until the parent form submits.
 */
export function PathMappingEditor({ mappings, onChange }: PathMappingEditorProps) {
  const [showForm, setShowForm] = useState(false);
  const [remotePath, setRemotePath] = useState('');
  const [localPath, setLocalPath] = useState('');

  const canAdd = remotePath.trim().length > 0 && localPath.trim().length > 0;

  const handleAdd = useCallback(() => {
    if (!canAdd) return;
    onChange([...mappings, { remotePath: remotePath.trim(), localPath: localPath.trim() }]);
    setRemotePath('');
    setLocalPath('');
    setShowForm(false);
  }, [canAdd, remotePath, localPath, mappings, onChange]);

  const handleRemove = useCallback((index: number) => {
    onChange(mappings.filter((_, i) => i !== index));
  }, [mappings, onChange]);

  return (
    <div className="sm:col-span-2 space-y-4 border-t border-border pt-5 mt-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="font-display text-base font-semibold">Remote Path Mappings</h4>
          <p className="text-sm text-muted-foreground">
            Map paths when this client runs in Docker or on a remote machine
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl transition-all focus-ring ${
            showForm
              ? 'bg-muted text-muted-foreground hover:bg-muted/80'
              : 'bg-primary/10 text-primary hover:bg-primary/20'
          }`}
        >
          {showForm ? <XIcon className="w-3.5 h-3.5" /> : <PlusIcon className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Mapping'}</span>
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <div className="glass-card rounded-2xl p-5 space-y-4 animate-fade-in">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="create-mapping-remote" className="block text-sm font-medium mb-2">Remote Path</label>
              <input
                id="create-mapping-remote"
                type="text"
                value={remotePath}
                onChange={(e) => setRemotePath(e.target.value)}
                placeholder="/downloads/complete/"
                className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm font-mono focus-ring focus:border-transparent transition-all"
              />
            </div>
            <div>
              <label htmlFor="create-mapping-local" className="block text-sm font-medium mb-2">Local Path</label>
              <input
                id="create-mapping-local"
                type="text"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="C:\downloads\"
                className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm font-mono focus-ring focus:border-transparent transition-all"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="flex items-center gap-2 px-4 py-2.5 font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!canAdd}
              className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* List */}
      {mappings.length === 0 && !showForm ? (
        <div className="glass-card rounded-2xl p-6 text-center">
          <FolderIcon className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            No path mappings configured. Add one if this client reports paths that differ from what Narratorr can access.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {mappings.map((mapping, index) => (
            <div
              key={`${mapping.remotePath}-${mapping.localPath}-${index}`}
              className="glass-card rounded-2xl p-4 flex items-center justify-between gap-4 group animate-fade-in-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="text-sm font-mono text-muted-foreground truncate" title={mapping.remotePath}>
                  {mapping.remotePath}
                </span>
                <ArrowRightIcon className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                <span className="text-sm font-mono truncate" title={mapping.localPath}>
                  {mapping.localPath}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(index)}
                className="px-2.5 py-1.5 text-xs font-medium text-destructive/70 hover:text-destructive border border-transparent hover:border-destructive/30 rounded-lg transition-all opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
