import { api, type Indexer } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { IndexerCard } from '@/components/settings/IndexerCard';
import { SearchIcon } from '@/components/icons';
import { CrudSettingsPage } from './CrudSettingsPage';
import { type CreateIndexerFormData } from '../../../shared/schemas.js';

export function IndexersSettings() {
  return (
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
  );
}
