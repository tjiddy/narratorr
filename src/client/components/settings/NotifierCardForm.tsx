import type { UseFormReturn } from 'react-hook-form';
import type { TestResult } from '@/lib/api';
import { TestResultMessage } from '@/components/TestResultMessage';
import { SettingsFormActions } from './SettingsFormActions';
import { NotifierFields } from './NotifierFields';
import { NOTIFIER_REGISTRY } from '../../../shared/notifier-registry.js';
import { EVENT_LABELS } from '../../../shared/notification-events.js';
import {
  notifierTypeSchema,
  notificationEventSchema,
  type CreateNotifierFormData,
} from '../../../shared/schemas.js';

interface NotifierCardFormProps {
  form: UseFormReturn<CreateNotifierFormData>;
  isEdit: boolean;
  selectedType: string;
  watchedEvents: string[];
  onSubmit: (data: CreateNotifierFormData) => void;
  onFormTest: (data: CreateNotifierFormData) => void;
  onCancel?: () => void;
  isPending?: boolean;
  testingForm?: boolean;
  formTestResult?: TestResult | null;
  onEventToggle: (event: string) => void;
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
                {NOTIFIER_REGISTRY[t]?.label || t}
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
