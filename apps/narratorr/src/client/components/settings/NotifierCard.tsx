/* eslint-disable max-lines */
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Notifier, TestResult } from '@/lib/api';
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
  createNotifierFormSchema,
  notifierTypeSchema,
  notificationEventSchema,
  type CreateNotifierFormData,
} from '../../../shared/schemas.js';

interface IdTestResult extends TestResult {
  id: number;
}

interface NotifierCardProps {
  notifier?: Notifier;
  mode: 'view' | 'edit' | 'create';
  onEdit?: () => void;
  onCancel?: () => void;
  onDelete?: () => void;
  onSubmit: (data: CreateNotifierFormData) => void;
  onFormTest: (data: CreateNotifierFormData) => void;
  onTest?: (id: number) => void;
  isPending?: boolean;
  testingId?: number | null;
  testResult?: IdTestResult | null;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  animationDelay?: string;
}

const TYPE_LABELS: Record<string, string> = {
  webhook: 'Webhook',
  discord: 'Discord',
  script: 'Custom Script',
};

const EVENT_LABELS: Record<string, string> = {
  on_grab: 'Grab',
  on_download_complete: 'Download Complete',
  on_import: 'Import',
  on_failure: 'Failure',
};

const defaultSettings: Record<string, CreateNotifierFormData['settings']> = {
  webhook: { url: '', method: 'POST' as const },
  discord: { webhookUrl: '', includeCover: true },
  script: { path: '', timeout: 30 },
};

function settingsFromNotifier(notifier: Notifier): CreateNotifierFormData['settings'] {
  const s = notifier.settings as Record<string, unknown>;
  return {
    url: (s.url as string) || '',
    method: (s.method as 'POST' | 'PUT') || 'POST',
    headers: (s.headers as string) || '',
    bodyTemplate: (s.bodyTemplate as string) || '',
    webhookUrl: (s.webhookUrl as string) || '',
    includeCover: (s.includeCover as boolean) ?? true,
    path: (s.path as string) || '',
    timeout: (s.timeout as number) || 30,
  };
}

function viewSubtitle(notifier: Notifier): string {
  const s = notifier.settings as Record<string, unknown>;
  if (notifier.type === 'webhook') return (s.url as string) || 'webhook';
  if (notifier.type === 'discord') return (s.webhookUrl as string)?.replace(/^https:\/\/discord\.com\/api\/webhooks\//, '...') || 'discord';
  if (notifier.type === 'script') return (s.path as string) || 'script';
  return notifier.type;
}

const defaultValues: CreateNotifierFormData = {
  name: '',
  type: 'webhook',
  enabled: true,
  events: ['on_grab', 'on_download_complete', 'on_import', 'on_failure'],
  settings: { url: '', method: 'POST' as const },
};

// eslint-disable-next-line max-lines-per-function, complexity
export function NotifierCard({
  notifier,
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
}: NotifierCardProps) {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<CreateNotifierFormData>({
    resolver: zodResolver(createNotifierFormSchema),
    defaultValues: notifier
      ? {
          name: notifier.name,
          type: notifier.type as CreateNotifierFormData['type'],
          enabled: notifier.enabled,
          events: notifier.events as CreateNotifierFormData['events'],
          settings: settingsFromNotifier(notifier),
        }
      : defaultValues,
  });

  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = watch('type');

  useEffect(() => {
    if (mode === 'edit' && notifier) {
      reset({
        name: notifier.name,
        type: notifier.type as CreateNotifierFormData['type'],
        enabled: notifier.enabled,
        events: notifier.events as CreateNotifierFormData['events'],
        settings: settingsFromNotifier(notifier),
      });
    } else if (mode === 'create') {
      reset(defaultValues);
    }
  }, [mode, notifier, reset]);

  useEffect(() => {
    if (mode === 'create') {
      setValue('settings', defaultSettings[selectedType] || defaultSettings.webhook);
    }
  }, [selectedType, mode, setValue]);

  const handleEventToggle = (event: string) => {
    const current = getValues('events') || [];
    if (current.includes(event as CreateNotifierFormData['events'][number])) {
      setValue('events', current.filter((e) => e !== event) as CreateNotifierFormData['events'], { shouldValidate: true });
    } else {
      setValue('events', [...current, event] as CreateNotifierFormData['events'], { shouldValidate: true });
    }
  };

  const watchedEvents = watch('events') || [];

  // View mode
  if (mode === 'view' && notifier) {
    return (
      <div
        className="glass-card rounded-2xl p-5 animate-fade-in-up"
        style={animationDelay ? { animationDelay } : undefined}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className={`w-3 h-3 rounded-full shrink-0 ${notifier.enabled ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'}`} />
            <div className="min-w-0">
              <h3 className="font-display font-semibold truncate">{notifier.name}</h3>
              <p className="text-sm text-muted-foreground truncate">
                {TYPE_LABELS[notifier.type] || notifier.type} — {viewSubtitle(notifier)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Events: {(notifier.events as string[]).map((e) => EVENT_LABELS[e] || e).join(', ')}
              </p>
              {testResult?.id === notifier.id && (
                <TestResultMessage
                  success={testResult.success}
                  message={testResult.message}
                  successText="Sent!"
                  failureText="Failed"
                />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onEdit}
              aria-label={`Edit ${notifier.name}`}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
            >
              <PencilIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Edit</span>
            </button>
            <TestButton
              testing={testingId === notifier.id}
              onClick={() => onTest?.(notifier.id)}
              variant="inline"
            />
            <button
              onClick={onDelete}
              aria-label={`Delete ${notifier.name}`}
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
        {isEdit ? 'Edit Notifier' : 'Add New Notifier'}
      </h3>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium mb-2">Name</label>
          <input
            type="text"
            {...register('name')}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.name ? 'border-destructive' : 'border-border'
            }`}
            placeholder="My Webhook"
          />
          {errors.name && (
            <p className="text-sm text-destructive mt-1">{errors.name.message}</p>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Type</label>
          <select
            {...register('type')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          >
            {notifierTypeSchema.options.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t] || t}
              </option>
            ))}
          </select>
        </div>

        {isEdit && (
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
        )}

        {/* Events checkboxes */}
        <div className={isEdit ? '' : 'sm:col-span-2'}>
          <label className="block text-sm font-medium mb-2">Events</label>
          <div className="flex flex-wrap gap-2">
            {notificationEventSchema.options.map((event) => (
              <label key={event} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={watchedEvents.includes(event)}
                  onChange={() => handleEventToggle(event)}
                  className="w-4 h-4 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
                />
                <span className="text-sm">{EVENT_LABELS[event] || event}</span>
              </label>
            ))}
          </div>
          {errors.events && (
            <p className="text-sm text-destructive mt-1">{errors.events.message}</p>
          )}
        </div>

        {/* Webhook fields */}
        {selectedType === 'webhook' && (
          <>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium mb-2">URL</label>
              <input
                type="text"
                {...register('settings.url')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.url ? 'border-destructive' : 'border-border'
                }`}
                placeholder="https://example.com/webhook"
              />
              {errors.settings?.url && (
                <p className="text-sm text-destructive mt-1">{errors.settings.url.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Method</label>
              <select
                {...register('settings.method')}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              >
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Headers (JSON)</label>
              <input
                type="text"
                {...register('settings.headers')}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
                placeholder='{"Authorization": "Bearer ..."}'
              />
              <p className="text-sm text-muted-foreground mt-1">Optional JSON key-value pairs</p>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium mb-2">Body Template</label>
              <textarea
                {...register('settings.bodyTemplate')}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all font-mono text-sm"
                rows={3}
                placeholder='{"event": "{event}", "title": "{book.title}", "author": "{book.author}"}'
              />
              <p className="text-sm text-muted-foreground mt-1">
                Leave empty for default JSON. Tokens: {'{event}'}, {'{book.title}'}, {'{book.author}'}, {'{error.message}'}
              </p>
            </div>
          </>
        )}

        {/* Discord fields */}
        {selectedType === 'discord' && (
          <>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium mb-2">Webhook URL</label>
              <input
                type="text"
                {...register('settings.webhookUrl')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.webhookUrl ? 'border-destructive' : 'border-border'
                }`}
                placeholder="https://discord.com/api/webhooks/..."
              />
              {errors.settings?.webhookUrl && (
                <p className="text-sm text-destructive mt-1">{errors.settings.webhookUrl.message}</p>
              )}
            </div>
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  {...register('settings.includeCover')}
                  className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
                />
                <span className="text-sm font-medium">Include Cover Image</span>
              </label>
            </div>
          </>
        )}

        {/* Script fields */}
        {selectedType === 'script' && (
          <>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium mb-2">Script Path</label>
              <input
                type="text"
                {...register('settings.path')}
                className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
                  errors.settings?.path ? 'border-destructive' : 'border-border'
                }`}
                placeholder="/path/to/script.sh"
              />
              {errors.settings?.path && (
                <p className="text-sm text-destructive mt-1">{errors.settings.path.message}</p>
              )}
              <p className="text-sm text-muted-foreground mt-1">
                Event data passed as environment variables (NARRATORR_EVENT, NARRATORR_BOOK_TITLE, etc.) and JSON on stdin
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Timeout (seconds)</label>
              <input
                type="number"
                {...register('settings.timeout', { valueAsNumber: true })}
                min={1}
                max={300}
                className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
              />
            </div>
          </>
        )}
      </div>

      {formTestResult && (
        <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
      )}

      <div className="flex items-center gap-3">
        <TestButton
          testing={!!testingForm}
          onClick={handleSubmit(onFormTest)}
          variant="form"
        />
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
              {isEdit ? 'Save Changes' : 'Add Notifier'}
            </>
          )}
        </button>
      </div>
    </form>
  );
}
