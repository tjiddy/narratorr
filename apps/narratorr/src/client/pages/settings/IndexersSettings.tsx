import { useState } from 'react';
import { api, type Indexer } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { IndexerCard } from '@/components/settings/IndexerCard';
import { ProwlarrImport } from '@/components/settings/ProwlarrImport';
import {
  LoadingSpinner,
  SearchIcon,
  PlusIcon,
  XIcon,
  DownloadCloudIcon,
} from '@/components/icons';
import { useCrudSettings } from '@/hooks/useCrudSettings';
import { type CreateIndexerFormData } from '../../../shared/schemas.js';

export function IndexersSettings() {
  const [showProwlarr, setShowProwlarr] = useState(false);
  const {
    items: indexers, isLoading, showForm, editingId,
    deleteTarget, setDeleteTarget,
    createMutation, updateMutation, deleteMutation,
    handleToggleForm, handleEdit, handleCancelEdit,
    testingId, testResult, testingForm, formTestResult,
    handleTest, handleFormTest,
  } = useCrudSettings<Indexer, CreateIndexerFormData>({
    queryKey: queryKeys.indexers(),
    queryFn: api.getIndexers,
    createFn: api.createIndexer,
    updateFn: api.updateIndexer,
    deleteFn: api.deleteIndexer,
    testById: api.testIndexer,
    testByConfig: api.testIndexerConfig,
    entityName: 'Indexer',
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <SearchIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Indexers</h2>
            <p className="text-sm text-muted-foreground">Manage audiobook search sources</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setShowProwlarr(!showProwlarr); if (showForm) handleToggleForm(); }}
            className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
              showProwlarr
                ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                : 'border border-border/50 hover:bg-muted/50'
            }`}
          >
            {showProwlarr ? <XIcon className="w-4 h-4" /> : <DownloadCloudIcon className="w-4 h-4" />}
            <span className="hidden sm:inline">{showProwlarr ? 'Close' : 'Prowlarr'}</span>
          </button>
          <button
            onClick={() => { handleToggleForm(); if (showProwlarr) setShowProwlarr(false); }}
            className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
              showForm
                ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            }`}
          >
            {showForm ? <XIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
            <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Indexer'}</span>
          </button>
        </div>
      </div>

      {/* Prowlarr Import */}
      {showProwlarr && (
        <ProwlarrImport onClose={() => setShowProwlarr(false)} />
      )}

      {/* Add Form */}
      {showForm && (
        <IndexerCard
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
      ) : indexers.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <SearchIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No indexers configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add an indexer to start searching for audiobooks
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {indexers.map((indexer, index) => (
            <IndexerCard
              key={indexer.id}
              indexer={indexer}
              mode={editingId === indexer.id ? 'edit' : 'view'}
              onEdit={() => handleEdit(indexer.id)}
              onCancel={handleCancelEdit}
              onDelete={() => setDeleteTarget(indexer)}
              onSubmit={(data) => updateMutation.mutate({ id: indexer.id, data })}
              onFormTest={handleFormTest}
              onTest={handleTest}
              isPending={updateMutation.isPending}
              testingId={testingId}
              testResult={testResult}
              testingForm={testingForm}
              formTestResult={editingId === indexer.id ? formTestResult : null}
              animationDelay={`${index * 50}ms`}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete Indexer"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
