import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Indexer, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { TestButton } from '@/components/TestButton';
import {
  LoadingSpinner,
  PlusIcon,
  PencilIcon,
  TrashIcon,
  CheckIcon,
  XIcon,
} from '@/components/icons';
import {
  createIndexerFormSchema,
  type CreateIndexerFormData,
} from '../../../shared/schemas.js';

interface IdTestResult extends TestResult {
  id: number;
}

interface IndexerCardProps {
  indexer?: Indexer;
  mode: 'view' | 'edit' | 'create';
  onEdit?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSubmit: (data: CreateIndexerFormData) => void;
  onFormTest: (data: CreateIndexerFormData) => void;
  onTest?: (id: number) => void;
  isPending?: boolean;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  animationDelay?: string;
}

const defaultValues: CreateIndexerFormData = {
  name: '',
  type: 'abb',
  enabled: true,
  priority: 50,
  settings: {
    hostname: '',
    pageLimit: 2,
  },
};

export function IndexerCard({
  indexer,
  mode,
  onEdit,
  onCancel,
  onDelete,
  onSubmit,
  onFormTest,
  onTest,
  isPending,
  testingId,
  testResult,
  testingForm,
  formTestResult,
  animationDelay,
}: IndexerCardProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateIndexerFormData>({
    resolver: zodResolver(createIndexerFormSchema),
    defaultValues: indexer
      ? {
          name: indexer.name,
          type: indexer.type as CreateIndexerFormData['type'],
          enabled: indexer.enabled,
          priority: indexer.priority,
          settings: {
            hostname: (indexer.settings as { hostname?: string }).hostname || '',
            pageLimit: (indexer.settings as { pageLimit?: number }).pageLimit || 2,
          },
        }
      : defaultValues,
  });

  useEffect(() => {
    if (mode === 'edit' && indexer) {
      reset({
        name: indexer.name,
        type: indexer.type as CreateIndexerFormData['type'],
        enabled: indexer.enabled,
        priority: indexer.priority,
        settings: {
          hostname: (indexer.settings as { hostname?: string }).hostname || '',
          pageLimit: (indexer.settings as { pageLimit?: number }).pageLimit || 2,
        },
      });
    } else if (mode === 'create') {
      reset(defaultValues);
    }
  }, [mode, indexer, reset]);

  // View mode
  if (mode === 'view' && indexer) {
    return (
      <div
        className="glass-card rounded-2xl p-5 animate-fade-in-up"
        style={animationDelay ? { animationDelay } : undefined}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className={`w-3 h-3 rounded-full shrink-0 ${indexer.enabled ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
            <div className="min-w-0">
              <h3 className="font-display font-semibold truncate">{indexer.name}</h3>
              <p className="text-sm text-muted-foreground truncate">
                {(indexer.settings as { hostname?: string }).hostname || indexer.type}
              </p>
              {testResult?.id === indexer.id && (
                <TestResultMessage
                  success={testResult.success}
                  message={testResult.message}
                  successText="Connected!"
                  failureText="Failed"
                />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onEdit}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
            >
              <PencilIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Edit</span>
            </button>
            <TestButton
              testing={testingId === indexer.id}
              onClick={() => onTest?.(indexer.id)}
              variant="inline"
            />
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-destructive border border-destructive/30 rounded-xl hover:bg-destructive hover:text-destructive-foreground transition-all focus-ring"
            >
              <TrashIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Delete</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Edit / Create form mode
  const isEdit = mode === 'edit';
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">
        {isEdit ? 'Edit Indexer' : 'Add New Indexer'}
      </h3>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="block text-sm font-medium mb-2">Name</label>
          <input
            type="text"
            {...register('name')}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.name ? 'border-destructive' : 'border-border'
            }`}
            placeholder="AudioBookBay"
          />
          {errors.name && (
            <p className="text-sm text-destructive mt-1">{errors.name.message}</p>
          )}
        </div>

        {isEdit && (
          <>
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  {...register('enabled')}
                  className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
                />
                <span className="text-sm font-medium">Enabled</span>
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Priority</label>
              <input
                type="number"
                {...register('priority', { valueAsNumber: true })}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
            </div>
          </>
        )}

        <div>
          <label className="block text-sm font-medium mb-2">Hostname</label>
          <input
            type="text"
            {...register('settings.hostname')}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.settings?.hostname ? 'border-destructive' : 'border-border'
            }`}
            placeholder="audiobookbay.lu"
          />
          {errors.settings?.hostname && (
            <p className="text-sm text-destructive mt-1">{errors.settings.hostname.message}</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-2">Page Limit</label>
          <input
            type="number"
            {...register('settings.pageLimit', { valueAsNumber: true })}
            min={1}
            max={10}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.settings?.pageLimit ? 'border-destructive' : 'border-border'
            }`}
          />
          {errors.settings?.pageLimit && (
            <p className="text-sm text-destructive mt-1">{errors.settings.pageLimit.message}</p>
          )}
        </div>
      </div>

      {formTestResult && (
        <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
      )}

      <div className="flex items-center gap-3">
        <TestButton testing={!!testingForm} onClick={handleSubmit(onFormTest)} variant="form" />
        {isEdit && (
          <button
            type="button"
            onClick={onCancel}
            className="flex items-center gap-2 px-4 py-3 font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
          >
            <XIcon className="w-4 h-4" />
            Cancel
          </button>
        )}
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 px-5 py-3 bg-primary text-primary-foreground font-medium rounded-xl hover:opacity-90 disabled:opacity-50 transition-all focus-ring"
        >
          {isPending ? (
            <>
              <LoadingSpinner className="w-4 h-4" />
              {isEdit ? 'Saving...' : 'Adding...'}
            </>
          ) : (
            <>
              {isEdit ? <CheckIcon className="w-4 h-4" /> : <PlusIcon className="w-4 h-4" />}
              {isEdit ? 'Save Changes' : 'Add Indexer'}
            </>
          )}
        </button>
      </div>
    </form>
  );
}
