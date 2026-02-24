import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type RemotePathMapping, type DownloadClient } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { PlusIcon, XIcon, LoadingSpinner, ArrowRightIcon, FolderIcon } from '@/components/icons';

interface MappingFormData {
  downloadClientId: number;
  remotePath: string;
  localPath: string;
}

function MappingForm({
  clients,
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  clients: DownloadClient[];
  initial?: MappingFormData;
  onSubmit: (data: MappingFormData) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [form, setForm] = useState<MappingFormData>(
    initial ?? { downloadClientId: clients[0]?.id ?? 0, remotePath: '', localPath: '' },
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.downloadClientId || !form.remotePath.trim() || !form.localPath.trim()) return;
    onSubmit(form);
  };

  return (
    <form onSubmit={handleSubmit} className="glass-card rounded-2xl p-5 space-y-4 animate-fade-in">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="rpm-client" className="block text-sm font-medium mb-2">Download Client</label>
          <select
            id="rpm-client"
            value={form.downloadClientId}
            onChange={(e) => setForm({ ...form, downloadClientId: parseInt(e.target.value, 10) })}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rpm-remote" className="block text-sm font-medium mb-2">Remote Path</label>
          <input
            id="rpm-remote"
            type="text"
            value={form.remotePath}
            onChange={(e) => setForm({ ...form, remotePath: e.target.value })}
            placeholder="/downloads/complete/"
            className="w-full px-4 py-3 bg-background border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          />
        </div>
        <div>
          <label htmlFor="rpm-local" className="block text-sm font-medium mb-2">Local Path</label>
          <input
            id="rpm-local"
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
          type="submit"
          disabled={isPending || !form.remotePath.trim() || !form.localPath.trim()}
          className="flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
        >
          {isPending ? <LoadingSpinner className="w-4 h-4" /> : null}
          {isPending ? 'Saving...' : 'Save'}
        </button>
      </div>
    </form>
  );
}

export function RemotePathMappingsSection() {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemotePathMapping | null>(null);

  const { data: mappings = [], isLoading } = useQuery({
    queryKey: queryKeys.remotePathMappings(),
    queryFn: api.getMappings,
  });

  const { data: clients = [] } = useQuery({
    queryKey: queryKeys.downloadClients(),
    queryFn: api.getClients,
  });

  const createMutation = useMutation({
    mutationFn: api.createMapping,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.remotePathMappings() });
      setShowForm(false);
      toast.success('Path mapping added');
    },
    onError: () => toast.error('Failed to add path mapping'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<MappingFormData> }) =>
      api.updateMapping(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.remotePathMappings() });
      setEditingId(null);
      toast.success('Path mapping updated');
    },
    onError: () => toast.error('Failed to update path mapping'),
  });

  const deleteMutation = useMutation({
    mutationFn: api.deleteMapping,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.remotePathMappings() });
      toast.success('Path mapping removed');
    },
    onError: () => toast.error('Failed to delete path mapping'),
  });

  const clientName = (id: number) => clients.find((c) => c.id === id)?.name ?? `Client #${id}`;

  if (clients.length === 0 && !isLoading) return null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-display text-lg font-semibold">Remote Path Mappings</h3>
          <p className="text-sm text-muted-foreground">
            Map paths when download clients run in Docker or on remote machines
          </p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); setEditingId(null); }}
          disabled={clients.length === 0}
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
          clients={clients}
          onSubmit={(data) => createMutation.mutate(data)}
          onCancel={() => setShowForm(false)}
          isPending={createMutation.isPending}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <LoadingSpinner className="w-6 h-6 text-primary" />
        </div>
      ) : mappings.length === 0 ? (
        <div className="glass-card rounded-2xl p-6 sm:p-8 text-center">
          <FolderIcon className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No path mappings configured. Add one if your download client reports paths that differ from what Narratorr can access.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {mappings.map((mapping, index) => (
            editingId === mapping.id ? (
              <MappingForm
                key={mapping.id}
                clients={clients}
                initial={{
                  downloadClientId: mapping.downloadClientId,
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
                <div className="flex-1 min-w-0 flex items-center gap-3">
                  <span className="text-sm font-medium shrink-0">{clientName(mapping.downloadClientId)}</span>
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-sm font-mono text-muted-foreground truncate" title={mapping.remotePath}>
                      {mapping.remotePath}
                    </span>
                    <ArrowRightIcon className="w-3.5 h-3.5 text-primary/60 shrink-0" />
                    <span className="text-sm font-mono truncate" title={mapping.localPath}>
                      {mapping.localPath}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => { setEditingId(mapping.id); setShowForm(false); }}
                    className="px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-transparent hover:border-border rounded-lg transition-all"
                  >
                    Edit
                  </button>
                  <button
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
        message={`Remove the path mapping from "${deleteTarget ? clientName(deleteTarget.downloadClientId) : ''}"? This may cause imports to fail if the paths don't match.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
