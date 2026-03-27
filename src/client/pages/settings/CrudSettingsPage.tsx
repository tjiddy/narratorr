import type { ReactNode } from 'react';
import type { TestResult } from '@/lib/api';
import { ConfirmModal } from '@/components/ConfirmModal';
import {
  LoadingSpinner,
  PlusIcon,
  XIcon,
} from '@/components/icons';
import { useCrudSettings, type CrudSettingsConfig } from '@/hooks/useCrudSettings';
import type { IdTestResult } from '@/hooks/useConnectionTest';

interface CrudSettingsPageProps<TItem extends { id: number; name: string }, TFormData> {
  config: CrudSettingsConfig<TItem, TFormData>;
  icon: ReactNode;
  title: string;
  subtitle: string;
  addLabel: string;
  emptyIcon: ReactNode;
  emptyTitle: string;
  emptySubtitle: string;
  deleteTitle: string;
  headerExtra?: ReactNode;
  renderCard: (item: TItem, handlers: {
    mode: 'view' | 'edit';
    onEdit: () => void;
    onCancel: () => void;
    onDelete: () => void;
    onSubmit: (data: TFormData) => void;
    onFormTest: (data: TFormData) => void;
    onTest: (id: number) => void;
    isPending: boolean;
    testingId: number | null;
    testResult: IdTestResult | null;
    testingForm: boolean;
    formTestResult: TestResult | null;
    animationDelay: string;
  }) => ReactNode;
  renderForm: (handlers: {
    onSubmit: (data: TFormData) => void;
    onFormTest: (data: TFormData) => void;
    isPending: boolean;
    testingForm: boolean;
    formTestResult: TestResult | null;
  }) => ReactNode;
}

export function CrudSettingsPage<TItem extends { id: number; name: string }, TFormData>({
  config,
  icon,
  title,
  subtitle,
  addLabel,
  emptyIcon,
  emptyTitle,
  emptySubtitle,
  deleteTitle,
  headerExtra,
  renderCard,
  renderForm,
}: CrudSettingsPageProps<TItem, TFormData>) {
  const { state, actions, mutations, tests } = useCrudSettings<TItem, TFormData>(config);
  const { items, isLoading, showForm, editingId, deleteTarget } = state;
  const { setDeleteTarget, handleToggleForm, handleEdit, handleCancelEdit } = actions;
  const { createMutation, updateMutation, deleteMutation } = mutations;
  const { testingId, testResult, testingForm, formTestResult, handleTest, handleFormTest } = tests;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            {icon}
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">{title}</h2>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          <button
            onClick={handleToggleForm}
            className={`flex items-center gap-2 px-4 py-2.5 font-medium rounded-xl transition-all focus-ring ${
              showForm
                ? 'bg-muted text-muted-foreground hover:bg-muted/80'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            }`}
          >
            {showForm ? <XIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
            <span className="hidden sm:inline">{showForm ? 'Cancel' : addLabel}</span>
          </button>
        </div>
      </div>

      {/* Add Form */}
      {showForm && renderForm({
        onSubmit: (data) => createMutation.mutate(data),
        onFormTest: handleFormTest,
        isPending: createMutation.isPending,
        testingForm,
        formTestResult,
      })}

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : items.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          {emptyIcon}
          <p className="text-lg font-medium">{emptyTitle}</p>
          <p className="text-sm text-muted-foreground mt-1">{emptySubtitle}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) =>
            renderCard(item, {
              mode: editingId === item.id ? 'edit' : 'view',
              onEdit: () => handleEdit(item.id),
              onCancel: handleCancelEdit,
              onDelete: () => setDeleteTarget(item),
              onSubmit: (data) => updateMutation.mutate({ id: item.id, data }),
              onFormTest: handleFormTest,
              onTest: handleTest,
              isPending: updateMutation.isPending,
              testingId,
              testResult,
              testingForm,
              formTestResult: editingId === item.id ? formTestResult : null,
              animationDelay: `${index * 50}ms`,
            }),
          )}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title={deleteTitle}
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
