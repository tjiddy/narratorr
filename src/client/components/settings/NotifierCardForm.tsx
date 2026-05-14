import type { UseFormReturn } from 'react-hook-form';
import type { TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { FormField } from './FormField';
import { SettingsFormActions } from './SettingsFormActions';
import { SelectWithChevron } from './SelectWithChevron';
import { NotifierFields } from './NotifierFields';
import { NOTIFIER_REGISTRY, type NotifierType } from '../../../shared/notifier-registry.js';
import { EVENT_LABELS, type NotificationEvent } from '../../../shared/notification-events.js';
import {
  notifierTypeSchema,
  notificationEventSchema,
  type CreateNotifierFormData,
} from '../../../shared/schemas.js';

interface NotifierCardFormProps {
  form: UseFormReturn<CreateNotifierFormData>;
  isEdit: boolean;
  selectedType: NotifierType;
  watchedEvents: NotificationEvent[];
  onSubmit: (data: CreateNotifierFormData) => void;
  onFormTest: (data: CreateNotifierFormData) => void;
  onCancel?: (() => void) | undefined;
  isPending?: boolean | undefined;
  testingForm?: boolean | undefined;
  formTestResult?: TestResult | null | undefined;
  onEventToggle: (event: NotificationEvent) => void;
}

export function NotifierCardForm(props: NotifierCardFormProps) {
  const {
    form, isEdit, selectedType, watchedEvents,
    onSubmit, onFormTest, onCancel, isPending, testingForm, formTestResult,
    onEventToggle,
  } = props;
  const { register, handleSubmit, formState: { errors } } = form;

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="glass-card rounded-2xl p-6 animate-fade-in-up space-y-5">
      <h3 className="font-display text-lg font-semibold">
        {isEdit ? 'Edit Notifier' : 'Add New Notifier'}
      </h3>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField id="notifierName" label="Name" registration={register('name')} error={errors.name} placeholder="My Webhook" />

        <SelectWithChevron id="notifierType" label="Type" {...register('type')} error={!!errors.type}>
          {notifierTypeSchema.options.map((t) => (
            <option key={t} value={t}>
              {NOTIFIER_REGISTRY[t]?.label || t}
            </option>
          ))}
        </SelectWithChevron>

        {isEdit && (
          <div>
            <label className={`flex items-center gap-3 ${watchedEvents.length === 0 ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                {...register('enabled')}
                disabled={watchedEvents.length === 0}
                aria-describedby={watchedEvents.length === 0 ? 'notifier-enabled-disabled-hint' : undefined}
                className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0 disabled:cursor-not-allowed"
              />
              <span className="text-sm font-medium">Enabled</span>
            </label>
            {watchedEvents.length === 0 && (
              <p id="notifier-enabled-disabled-hint" className="text-xs text-muted-foreground mt-1">
                Select at least one event to enable this notifier.
              </p>
            )}
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
                  onChange={() => onEventToggle(event)}
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

      <div className="min-h-5">
        {formTestResult && (
          <TestResultMessage success={formTestResult.success} message={formTestResult.message} />
        )}
      </div>

      <SettingsFormActions
        isEdit={isEdit}
        isPending={isPending}
        testingForm={testingForm}
        onFormTest={handleSubmit((data) => onFormTest(data))}
        onCancel={onCancel}
        entityLabel="Notifier"
      />
    </form>
  );
}
