import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { CreateNotifierFormData } from '../../../shared/schemas.js';

interface NotifierFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateNotifierFormData>;
  errors: FieldErrors<CreateNotifierFormData>;
}

// eslint-disable-next-line complexity -- 3 type branches with error display are inherently complex
export function NotifierFields({ selectedType, register, errors }: NotifierFieldsProps) {
  if (selectedType === 'webhook') {
    return (
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
    );
  }

  if (selectedType === 'discord') {
    return (
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
    );
  }

  if (selectedType === 'script') {
    return (
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
    );
  }

  return null;
}
