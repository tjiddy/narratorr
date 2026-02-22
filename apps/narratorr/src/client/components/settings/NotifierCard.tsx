import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Notifier, TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { SettingsFormActions } from './SettingsFormActions';
import { NotifierFields } from './NotifierFields';
import {
  createNotifierFormSchema,
  notifierTypeSchema,
  notificationEventSchema,
  type CreateNotifierFormData,
} from '../../../shared/schemas.js';

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

export function NotifierCard(props: NotifierCardProps) {
  const {
    notifier, mode, onEdit, onCancel, onDelete, onSubmit, onFormTest,
    onTest, isPending, testingId, testResult, testingForm, formTestResult, animationDelay,
  } = props;
  const {
    register, handleSubmit, reset, watch, setValue, getValues,
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

  if (mode === 'view' && notifier) {
    return (
      <SettingsCardShell
        name={notifier.name}
        subtitle={`${TYPE_LABELS[notifier.type] || notifier.type} — ${viewSubtitle(notifier)}`}
        enabled={notifier.enabled}
        itemId={notifier.id}
        onEdit={onEdit}
        onTest={onTest}
        onDelete={onDelete}
        testingId={testingId}
        testResult={testResult}
        testResultTexts={{ success: 'Sent!', failure: 'Failed' }}
        animationDelay={animationDelay}
      >
        <p className="text-xs text-muted-foreground mt-1">
          Events: {(notifier.events as string[]).map((e) => EVENT_LABELS[e] || e).join(', ')}
        </p>
      </SettingsCardShell>
    );
  }

  const isEdit = mode === 'edit';
  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">
        {isEdit ? 'Edit Notifier' : 'Add New Notifier'}
      </h3>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="notifierName" className="block text-sm font-medium mb-2">Name</label>
          <input id="notifierName" type="text"
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
          <label htmlFor="notifierType" className="block text-sm font-medium mb-2">Type</label>
          <select id="notifierType" {...register('type')}
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

        <NotifierFields selectedType={selectedType} register={register} errors={errors} />
      </div>

      {formTestResult && (
        <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
      )}

      <SettingsFormActions
        isEdit={isEdit}
        isPending={isPending}
        testingForm={testingForm}
        onFormTest={handleSubmit(onFormTest)}
        onCancel={onCancel}
        entityLabel="Notifier"
      />
    </form>
  );
}
