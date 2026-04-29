// Does not use useSettingsForm: entity form for notifier CRUD, not a settings category patch.
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Notifier, TestResult } from '@/lib/api';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { NotifierCardForm } from './NotifierCardForm';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES } from '../../../shared/notifier-registry.js';
import { EVENT_LABELS } from '../../../shared/notification-events.js';
import {
  createNotifierFormSchema,
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

function settingsFromNotifier(notifier: Notifier): CreateNotifierFormData['settings'] {
  const meta = NOTIFIER_REGISTRY[notifier.type];
  const defaults = meta?.defaultSettings ?? {};
  const saved = notifier.settings as Record<string, unknown>;
  const result: Record<string, unknown> = { ...defaults };
  for (const [key, val] of Object.entries(saved)) {
    if (val != null) result[key] = val;
  }
  return result as CreateNotifierFormData['settings'];
}

function viewSubtitle(notifier: Notifier): string {
  const meta = NOTIFIER_REGISTRY[notifier.type];
  if (!meta) return notifier.type;
  return meta.viewSubtitle(notifier.settings as Record<string, unknown>);
}

const defaultValues: CreateNotifierFormData = {
  name: '',
  type: NOTIFIER_TYPES[0],
  enabled: true,
  events: ['on_grab', 'on_download_complete', 'on_import', 'on_failure', 'on_upgrade', 'on_health_issue'],
  settings: NOTIFIER_REGISTRY[NOTIFIER_TYPES[0]].defaultSettings,
};

export function NotifierCard(props: NotifierCardProps) {
  const {
    notifier, mode, onEdit, onCancel, onDelete, onSubmit, onFormTest,
    onTest, isPending, testingId, testResult, testingForm, formTestResult, animationDelay,
  } = props;
  const form = useForm<CreateNotifierFormData>({
    resolver: zodResolver(createNotifierFormSchema),
    defaultValues: notifier
      ? {
          name: notifier.name,
          type: notifier.type as CreateNotifierFormData['type'],
          enabled: notifier.enabled,
          events: notifier.events,
          settings: settingsFromNotifier(notifier),
        }
      : defaultValues,
  });
  const { reset, setValue, getValues } = form;

  // eslint-disable-next-line react-hooks/incompatible-library
  const selectedType = form.watch('type');

  useEffect(() => {
    if (mode === 'edit' && notifier) {
      reset({
        name: notifier.name,
        type: notifier.type as CreateNotifierFormData['type'],
        enabled: notifier.enabled,
        events: notifier.events,
        settings: settingsFromNotifier(notifier),
      });
    } else if (mode === 'create') {
      reset(defaultValues);
    }
  }, [mode, notifier, reset]);

  useEffect(() => {
    if (mode === 'create') {
      const meta = NOTIFIER_REGISTRY[selectedType];
      setValue('settings', meta?.defaultSettings || NOTIFIER_REGISTRY[NOTIFIER_TYPES[0]].defaultSettings);
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

  const watchedEvents = form.watch('events') || [];

  if (mode === 'view' && notifier) {
    const typeLabel = NOTIFIER_REGISTRY[notifier.type]?.label || notifier.type;
    return (
      <SettingsCardShell
        name={notifier.name}
        subtitle={`${typeLabel} — ${viewSubtitle(notifier)}`}
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
          Events: {notifier.events.map((e) => EVENT_LABELS[e] || e).join(', ')}
        </p>
      </SettingsCardShell>
    );
  }

  // In edit mode, include the notifier id so the server can resolve masked
  // sentinel values against saved decrypted settings before running the test.
  const handleFormTest = (data: CreateNotifierFormData) => {
    if (notifier?.id) {
      onFormTest({ ...data, id: notifier.id } as CreateNotifierFormData);
    } else {
      onFormTest(data);
    }
  };

  return (
    <NotifierCardForm
      form={form}
      isEdit={mode === 'edit'}
      selectedType={selectedType}
      watchedEvents={watchedEvents}
      onSubmit={onSubmit}
      onFormTest={handleFormTest}
      onCancel={onCancel}
      isPending={isPending}
      testingForm={testingForm}
      formTestResult={formTestResult}
      onEventToggle={handleEventToggle}
    />
  );
}
