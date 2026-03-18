import { useState } from 'react';
import { api, type Indexer } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { IndexerCard } from '@/components/settings/IndexerCard';
import { ProwlarrImport } from '@/components/settings/ProwlarrImport';
import { SearchIcon, DownloadCloudIcon } from '@/components/icons';
import { CrudSettingsPage } from './CrudSettingsPage';
import { type CreateIndexerFormData } from '../../../shared/schemas.js';

export function IndexersSettings() {
  const [showProwlarr, setShowProwlarr] = useState(false);

  return (
    <>
      <CrudSettingsPage<Indexer, CreateIndexerFormData>
        config={{
          queryKey: queryKeys.indexers(),
          queryFn: api.getIndexers,
          createFn: api.createIndexer,
          updateFn: api.updateIndexer,
          deleteFn: api.deleteIndexer,
          testById: api.testIndexer,
          testByConfig: api.testIndexerConfig,
          entityName: 'Indexer',
        }}
        icon={<SearchIcon className="w-5 h-5 text-primary" />}
        title="Indexers"
        subtitle="Manage audiobook search sources"
        addLabel="Add Indexer"
        emptyIcon={<SearchIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />}
        emptyTitle="No indexers configured"
        emptySubtitle="Add an indexer to start searching for audiobooks"
        deleteTitle="Delete Indexer"
        headerExtra={
          <button
            type="button"
            onClick={() => setShowProwlarr(true)}
            className="flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl border border-border/50 hover:bg-muted/50 transition-all focus-ring"
          >
            <DownloadCloudIcon className="w-4 h-4" />
            <span className="hidden sm:inline">Prowlarr</span>
          </button>
        }
        renderCard={(indexer, handlers) => (
          <IndexerCard
            key={indexer.id}
            indexer={indexer}
            mode={handlers.mode}
            onEdit={handlers.onEdit}
            onCancel={handlers.onCancel}
            onDelete={handlers.onDelete}
            onSubmit={handlers.onSubmit}
            onFormTest={handlers.onFormTest}
            onTest={handlers.onTest}
            isPending={handlers.isPending}
            testingId={handlers.testingId}
            testResult={handlers.testResult}
            testingForm={handlers.testingForm}
            formTestResult={handlers.formTestResult}
            animationDelay={handlers.animationDelay}
          />
        )}
        renderForm={(handlers) => (
          <IndexerCard
            mode="create"
            onSubmit={handlers.onSubmit}
            onFormTest={handlers.onFormTest}
            isPending={handlers.isPending}
            testingForm={handlers.testingForm}
            formTestResult={handlers.formTestResult}
          />
        )}
      />
      <ProwlarrImport isOpen={showProwlarr} onClose={() => setShowProwlarr(false)} />
    </>
  );
}
