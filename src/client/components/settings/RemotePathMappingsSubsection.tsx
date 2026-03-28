import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type RemotePathMapping } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useMutationWithToast } from '@/hooks/useMutationWithToast';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PlusIcon, XIcon, LoadingSpinner, ArrowRightIcon, FolderIcon } from '@/components/icons';

interface MappingFormData {
  remotePath: string;
  localPath: string;
}

function MappingForm({
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  initial?: MappingFormData;
  onSubmit: (data: MappingFormData) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<MappingFormData>(
    initial ?? { remotePath: '', localPath: '' },
  );

  const handleSave = () => {
    if (!form.remotePath.trim() || !form.localPath.trim()) return;
    onSubmit(form);
  };

  return (
    <div className="glass-card rounded-2xl p-5 space-y-4 animate-fade-in">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="mapping-remote" className="block text-sm font-medium mb-2">Remote Path</label>
          <input
            id="mapping-remote"
            type="text"
            value={form.remotePath}
            onChange={(e) => setForm({ ...form, remotePath: e.target.value })}
            placeholder="/downloads/complete/"
            className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          />
        </div>
        <div>
          <label htmlFor="mapping-local" className="block text-sm font-medium mb-2">Local Path</label>
          <input
            id="mapping-local"
            type="text"
            value={form.localPath}
            onChange={(e) => setForm({ ...form, localPath: e.target.value })}
            placeholder="C:\downloads\"
            className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          />
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-2 px-4 py-2.5 font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !form.remotePath.trim() || !form.localPath.trim()}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
        >
          {isPending ? <LoadingSpinner className="w-4 h-4" /> : null}
          {isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

interface RemotePathMappingsSubsectionProps {
  clientId: number;
}

export function RemotePathMappingsSubsection({ clientId }: RemotePathMappingsSubsectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemotePathMapping | null>(null);

  const { data: mappings = [], isLoading } = useQuery({
    queryKey: queryKeys.remotePathMappings(clientId),
    queryFn: () => api.getRemotePathMappingsByClientId(clientId),
  });

  const createMutation = useMutationWithToast({
    mutationFn: api.createRemotePathMapping,
    queryKey: queryKeys.remotePathMappings(clientId),
    successMessage: 'Path mapping added',
    errorMessage: 'Failed to add path mapping',
    onSuccess: () => setShowForm(false),
  });

  const updateMutation = useMutationWithToast({
    mutationFn: ({ id, data }: { id: number; data: Partial<MappingFormData> }) =>
      api.updateRemotePathMapping(id, data),
    queryKey: queryKeys.remotePathMappings(clientId),
    successMessage: 'Path mapping updated',
    errorMessage: 'Failed to update path mapping',
    onSuccess: () => setEditingId(null),
  });

  const deleteMutation = useMutationWithToast({
    mutationFn: api.deleteRemotePathMapping,
    queryKey: queryKeys.remotePathMappings(clientId),
    successMessage: 'Path mapping removed',
    errorMessage: 'Failed to delete path mapping',
  });

  return (
    <div className="space-y-4 border-t border-border pt-5 mt-5">
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
          onClick={() => { setShowForm(!showForm); setEditingId(null); }}
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
        <MappingForm
          onSubmit={(data) => createMutation.mutate({ ...data, downloadClientId: clientId })}
          onCancel={() => setShowForm(false)}
          isPending={createMutation.isPending}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <LoadingSpinner className="w-6 h-6 text-primary" />
        </div>
      ) : mappings.length === 0 && !showForm ? (
        <div className="glass-card rounded-2xl p-6 text-center">
          <FolderIcon className="w-8 h-8 text-muted-foreground/30 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            No path mappings configured. Add one if this client reports paths that differ from what Narratorr can access.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {mappings.map((mapping, index) => (
            editingId === mapping.id ? (
              <MappingForm
                key={mapping.id}
                initial={{
                  remotePath: mapping.remotePath,
                  localPath: mapping.localPath,
                }}
                onSubmit={(data) => updateMutation.mutate({ id: mapping.id, data })}
                onCancel={() => setEditingId(null)}
                isPending={updateMutation.isPending}
              />
            ) : (
              <div
                key={mapping.id}
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
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => { setEditingId(mapping.id); setShowForm(false); }}
                    className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-transparent hover:border-border rounded-lg transition-all"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(mapping)}
                    className="px-2.5 py-1.5 text-xs font-medium text-destructive/70 hover:text-destructive border border-transparent hover:border-destructive/30 rounded-lg transition-all"
                  >
                    Delete
                  </button>
                </div>
              </div>
            )
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete Path Mapping"
        message={`Remove this path mapping? This may cause imports to fail if the paths don't match.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
