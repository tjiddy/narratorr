import { api, type Connector } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConnectorCard } from '@/components/settings/ConnectorCard';
import { RefreshIcon } from '@/components/icons';
import { CrudSettingsPage } from './CrudSettingsPage';
import { type CreateConnectorFormData } from '../../../shared/schemas.js';

export function ConnectorsSettings() {
  return (
    <CrudSettingsPage<Connector, CreateConnectorFormData>
      modal
      config={{
        queryKey: queryKeys.connectors(),
        queryFn: api.getConnectors,
        createFn: api.createConnector,
        updateFn: api.updateConnector,
        deleteFn: api.deleteConnector,
        testById: api.testConnector,
        testByConfig: api.testConnectorConfig,
        entityName: 'Connector',
        injectEditingId: true,
      }}
      icon={<RefreshIcon className="w-5 h-5 text-primary" />}
      title="Connectors"
      subtitle="Refresh your media server (Audiobookshelf) when the library changes"
      addLabel="Add Connector"
      emptyIcon={<RefreshIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />}
      emptyTitle="No connectors configured"
      emptySubtitle="Add a connector to push a library scan to your media server on import"
      deleteTitle="Delete Connector"
      renderCard={(connector, handlers) => (
        <ConnectorCard
          key={connector.id}
          connector={connector}
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
        <ConnectorCard
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
