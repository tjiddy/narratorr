// Does not use useSettingsForm: entity form for notifier CRUD, not a settings category patch.
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { Notifier, TestResult } from '@/lib/api';
import { SettingsCardShell, type IdTestResult } from './SettingsCardShell';
import { NotifierCardForm } from './NotifierCardForm';
import { NOTIFIER_REGISTRY, NOTIFIER_TYPES } from '../../../shared/notifier-registry.js';
import { EVENT_LABELS, type NotificationEvent } from '../../../shared/notification-events.js';
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
  const ownKeys = new Set(Object.keys(defaults));
  const result: Record<string, unknown> = { ...defaults };
  // Overlay only non-null stored values that belong to this notifier type. Dropping stale
  // foreign keys (e.g. a Telegram `botToken` left on a webhook row by a legacy or hand-edited
  // DB) keeps them out of the form state and therefore out of the per-type strict server
  // schema, which would otherwise 400. Safe because notifier `defaultSettings` keys ≡ the
  // strict per-type schema keys for every type — pinned by the schema-alignment test in
  // NotifierCard.test.tsx — so this never drops a valid key. (Null values are skipped so the
  // registry default backfills, e.g. discord `includeCover`.) The sibling overlays
  // `settingsFromIndexer`/`settingsFromClient` are deliberately NOT filtered this way: their
  // valid key set is the schema, a superset of `defaultSettings` (MAM `isVip`/`classname`,
  // download-client `useSsl`), so a defaults-based filter there would drop valid keys.
  for (const [key, val] of Object.entries(notifier.settings)) {
    if (val != null && ownKeys.has(key)) result[key] = val;
  }
  return result as CreateNotifierFormData['settings'];
}

function viewSubtitle(notifier: Notifier): string {
  const meta = NOTIFIER_REGISTRY[notifier.type];
  if (!meta) return notifier.type;
  return meta.viewSubtitle(notifier.settings);
}

const defaultValues: CreateNotifierFormData = {
  name: '',
  type: NOTIFIER_TYPES[0],
  enabled: true,
  events: ['on_grab', 'on_download_complete', 'on_import', 'on_failure', 'on_health_issue'],
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
          type: notifier.type,
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
        type: notifier.type,
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

  const handleEventToggle = (event: NotificationEvent) => {
    const current = getValues('events') || [];
    if (current.includes(event)) {
      setValue('events', current.filter((e) => e !== event), { shouldValidate: true });
    } else {
      setValue('events', [...current, event], { shouldValidate: true });
    }
  };

  const watchedEvents = form.watch('events') || [];

  if (mode === 'view' && notifier) {
    const typeLabel = NOTIFIER_REGISTRY[notifier.type]?.label || notifier.type;
    const hasEvents = notifier.events.length > 0;
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
        {hasEvents ? (
          <p className="text-xs text-muted-foreground mt-1">
            Events: {notifier.events.map((e) => EVENT_LABELS[e] || e).join(', ')}
          </p>
        ) : (
          <p className="text-xs text-yellow-400 mt-1" data-testid="notifier-empty-events-hint">
            No events selected — select at least one event to re-enable.
          </p>
        )}
      </SettingsCardShell>
    );
  }

  return (
    <NotifierCardForm
      form={form}
      isEdit={mode === 'edit'}
      selectedType={selectedType}
      watchedEvents={watchedEvents}
      onSubmit={onSubmit}
      onFormTest={onFormTest}
      onCancel={onCancel}
      isPending={isPending}
      testingForm={testingForm}
      formTestResult={formTestResult}
      onEventToggle={handleEventToggle}
    />
  );
}
