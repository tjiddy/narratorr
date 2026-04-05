import { api, type DownloadClient } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { DownloadClientCard } from '@/components/settings/DownloadClientCard';
import { ServerIcon } from '@/components/icons';
import { CrudSettingsPage } from './CrudSettingsPage';
import { type CreateDownloadClientFormData } from '../../../shared/schemas.js';

export function DownloadClientsSettings() {
  return (
    <CrudSettingsPage<DownloadClient, CreateDownloadClientFormData>
      modal
      config={{
        queryKey: queryKeys.downloadClients(),
        queryFn: api.getClients,
        createFn: api.createClient,
        updateFn: api.updateClient,
        deleteFn: api.deleteClient,
        testById: api.testClient,
        testByConfig: api.testClientConfig,
        entityName: 'Download client',
      }}
      icon={<ServerIcon className="w-5 h-5 text-primary" />}
      title="Download Clients"
      subtitle="Manage torrent clients"
      addLabel="Add Client"
      emptyIcon={<ServerIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />}
      emptyTitle="No download clients configured"
      emptySubtitle="Add a download client to start grabbing audiobooks"
      deleteTitle="Delete Download Client"
      renderCard={(client, handlers) => (
        <DownloadClientCard
          key={client.id}
          client={client}
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
          inModal={handlers.inModal}
        />
      )}
      renderForm={(handlers) => (
        <DownloadClientCard
          mode="create"
          onSubmit={handlers.onSubmit}
          onFormTest={handlers.onFormTest}
          onCancel={handlers.onCancel}
          isPending={handlers.isPending}
          testingForm={handlers.testingForm}
          formTestResult={handlers.formTestResult}
          inModal={handlers.inModal}
        />
      )}
    />
  );
}
