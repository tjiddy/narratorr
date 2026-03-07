import { api, type Notifier } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { NotifierCard } from '@/components/settings/NotifierCard';
import {
  LoadingSpinner,
  BellIcon,
  PlusIcon,
  XIcon,
} from '@/components/icons';
import { useCrudSettings } from '@/hooks/useCrudSettings';
import { type CreateNotifierFormData } from '../../../shared/schemas.js';

export function NotificationsSettings() {
  const {
    items: notifiers, isLoading, showForm, editingId,
    deleteTarget, setDeleteTarget,
    createMutation, updateMutation, deleteMutation,
    handleToggleForm, handleEdit, handleCancelEdit,
    testingId, testResult, testingForm, formTestResult,
    handleTest, handleFormTest,
  } = useCrudSettings<Notifier, CreateNotifierFormData>({
    queryKey: queryKeys.notifiers(),
    queryFn: api.getNotifiers,
    createFn: api.createNotifier,
    updateFn: api.updateNotifier,
    deleteFn: api.deleteNotifier,
    testById: api.testNotifier,
    testByConfig: api.testNotifierConfig,
    entityName: 'Notifier',
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <BellIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Notifications</h2>
            <p className="text-sm text-muted-foreground">Get notified on grabs, downloads, imports, and failures</p>
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
          <span className="hidden sm:inline">{showForm ? 'Cancel' : 'Add Notifier'}</span>
        </button>
      </div>

      {/* Add Form */}
      {showForm && (
        <NotifierCard
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
      ) : notifiers.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <BellIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No notifications configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add a notifier to get alerts on grabs, downloads, and imports
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {notifiers.map((notifier, index) => (
            <NotifierCard
              key={notifier.id}
              notifier={notifier}
              mode={editingId === notifier.id ? 'edit' : 'view'}
              onEdit={() => handleEdit(notifier.id)}
              onCancel={handleCancelEdit}
              onDelete={() => setDeleteTarget(notifier)}
              onSubmit={(data) => updateMutation.mutate({ id: notifier.id, data })}
              onFormTest={handleFormTest}
              onTest={handleTest}
              isPending={updateMutation.isPending}
              testingId={testingId}
              testResult={testResult}
              testingForm={testingForm}
              formTestResult={editingId === notifier.id ? formTestResult : null}
              animationDelay={`${index * 50}ms`}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete Notifier"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
