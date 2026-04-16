import { api, type Notifier } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { NotifierCard } from '@/components/settings/NotifierCard';
import { BellIcon } from '@/components/icons';
import { CrudSettingsPage } from './CrudSettingsPage';
import { type CreateNotifierFormData } from '../../../shared/schemas.js';

export function NotificationsSettings() {
  return (
    <CrudSettingsPage<Notifier, CreateNotifierFormData>
      modal
      config={{
        queryKey: queryKeys.notifiers(),
        queryFn: api.getNotifiers,
        createFn: api.createNotifier,
        updateFn: api.updateNotifier,
        deleteFn: api.deleteNotifier,
        testById: api.testNotifier,
        testByConfig: api.testNotifierConfig,
        entityName: 'Notifier',
      }}
      icon={<BellIcon className="w-5 h-5 text-primary" />}
      title="Notifications"
      subtitle="Get notified on grabs, downloads, imports, and failures"
      addLabel="Add Notifier"
      emptyIcon={<BellIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />}
      emptyTitle="No notifications configured"
      emptySubtitle="Add a notifier to get alerts on grabs, downloads, and imports"
      deleteTitle="Delete Notifier"
      renderCard={(notifier, handlers) => (
        <NotifierCard
          key={notifier.id}
          notifier={notifier}
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
        <NotifierCard
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
