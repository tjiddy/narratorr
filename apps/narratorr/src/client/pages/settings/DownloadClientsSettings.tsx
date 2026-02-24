import { api, type DownloadClient } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { DownloadClientCard } from '@/components/settings/DownloadClientCard';
import {
  LoadingSpinner,
  ServerIcon,
  PlusIcon,
  XIcon,
} from '@/components/icons';
import { useCrudSettings } from '@/hooks/useCrudSettings';
import { type CreateDownloadClientFormData } from '../../../shared/schemas.js';

export function DownloadClientsSettings() {
  const {
    items: clients, isLoading, showForm, editingId,
    deleteTarget, setDeleteTarget,
    createMutation, updateMutation, deleteMutation,
    handleToggleForm, handleEdit, handleCancelEdit,
    testingId, testResult, testingForm, formTestResult,
    handleTest, handleFormTest,
  } = useCrudSettings<DownloadClient, CreateDownloadClientFormData>({
    queryKey: queryKeys.downloadClients(),
    queryFn: api.getClients,
    createFn: api.createClient,
    updateFn: api.updateClient,
    deleteFn: api.deleteClient,
    testById: api.testClient,
    testByConfig: api.testClientConfig,
    entityName: 'Download client',
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <ServerIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Download Clients</h2>
            <p className="text-sm text-muted-foreground">Manage torrent clients</p>
          </div>
        </div>
        <button
          onClick={handleToggleForm}
          className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
            showForm
              ? 'bg-muted text-muted-foreground hover:bg-muted/80'
              : 'bg-primary text-primary-foreground hover:opacity-90'
          }`}
        >
          {showForm ? <XIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
          <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Client'}</span>
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <DownloadClientCard
          mode="create"
          onSubmit={(data) => createMutation.mutate(data)}
          onFormTest={handleFormTest}
          isPending={createMutation.isPending}
          testingForm={testingForm}
          formTestResult={formTestResult}
        />
      )}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : clients.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <ServerIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No download clients configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add a download client to start grabbing audiobooks
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {clients.map((client, index) => (
            <DownloadClientCard
              key={client.id}
              client={client}
              mode={editingId === client.id ? 'edit' : 'view'}
              onEdit={() => handleEdit(client.id)}
              onCancel={handleCancelEdit}
              onDelete={() => setDeleteTarget(client)}
              onSubmit={(data) => updateMutation.mutate({ id: client.id, data })}
              onFormTest={handleFormTest}
              onTest={handleTest}
              isPending={updateMutation.isPending}
              testingId={testingId}
              testResult={testResult}
              testingForm={testingForm}
              formTestResult={editingId === client.id ? formTestResult : null}
              animationDelay={`${index * 50}ms`}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete Download Client"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
