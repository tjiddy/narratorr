import { api, type ImportList } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ImportListCard, type ImportListFormData } from '@/components/settings/ImportListCard';
import { ListIcon } from '@/components/icons';
import { CrudSettingsPage } from './CrudSettingsPage';

export function ImportListsSettings() {
  return (
    <CrudSettingsPage<ImportList, ImportListFormData>
      modal
      config={{
        queryKey: queryKeys.importLists(),
        queryFn: api.getImportLists,
        createFn: api.createImportList,
        updateFn: api.updateImportList,
        deleteFn: api.deleteImportList,
        testById: api.testImportList,
        testByConfig: api.testImportListConfig,
        entityName: 'Import list',
      }}
      icon={<ListIcon className="w-5 h-5 text-primary" />}
      title="Import Lists"
      subtitle="Auto-add books from external sources"
      addLabel="Add Import List"
      emptyIcon={<ListIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />}
      emptyTitle="No import lists configured"
      emptySubtitle="Add an import list to automatically discover books from Audiobookshelf, NYT, or Hardcover"
      deleteTitle="Delete Import List"
      renderCard={(list, handlers) => (
        <ImportListCard
          key={list.id}
          list={list}
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
        <ImportListCard
          mode="create"
          onSubmit={handlers.onSubmit}
          onFormTest={handlers.onFormTest}
          onCancel={handlers.onCancel}
          isPending={handlers.isPending}
          testingForm={handlers.testingForm}
          formTestResult={handlers.formTestResult}
        />
      )}
    />
  );
}
