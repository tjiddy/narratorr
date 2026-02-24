import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';

const TYPE_FIELDS: Record<string, { username: boolean; password: boolean; useSsl: boolean; apiKey: boolean }> = {
  qbittorrent: { username: true, password: true, useSsl: true, apiKey: false },
  transmission: { username: true, password: true, useSsl: true, apiKey: false },
  sabnzbd: { username: false, password: false, useSsl: true, apiKey: true },
  nzbget: { username: true, password: true, useSsl: true, apiKey: false },
};

interface DownloadClientFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateDownloadClientFormData>;
  errors: FieldErrors<CreateDownloadClientFormData>;
}

// eslint-disable-next-line complexity -- conditional fields per client type are inherently branchy
export function DownloadClientFields({ selectedType, register, errors }: DownloadClientFieldsProps) {
  const fields = TYPE_FIELDS[selectedType] || TYPE_FIELDS.qbittorrent;

  return (
    <>
      <div>
        <label htmlFor="clientHost" className="block text-sm font-medium mb-2">Host</label>
        <input
          id="clientHost"
          type="text"
          {...register('settings.host')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.settings?.host ? 'border-destructive' : 'border-border'
          }`}
          placeholder="localhost"
        />
        {errors.settings?.host ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.host.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Hostname or IP without protocol</p>
        )}
      </div>
      <div>
        <label htmlFor="clientPort" className="block text-sm font-medium mb-2">Port</label>
        <input
          id="clientPort"
          type="number"
          {...register('settings.port', { valueAsNumber: true })}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.settings?.port ? 'border-destructive' : 'border-border'
          }`}
        />
        {errors.settings?.port && (
          <p className="text-sm text-destructive mt-1">{errors.settings.port.message}</p>
        )}
      </div>

      {fields.username && (
        <div>
          <label htmlFor="clientUsername" className="block text-sm font-medium mb-2">Username</label>
          <input
            id="clientUsername"
            type="text"
            {...register('settings.username')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            placeholder="admin"
          />
        </div>
      )}
      {fields.password && (
        <div>
          <label htmlFor="clientPassword" className="block text-sm font-medium mb-2">Password</label>
          <input
            id="clientPassword"
            type="password"
            {...register('settings.password')}
            className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          />
        </div>
      )}

      {fields.apiKey && (
        <div className="sm:col-span-2">
          <label htmlFor="clientApiKey" className="block text-sm font-medium mb-2">API Key</label>
          <input
            id="clientApiKey"
            type="password"
            {...register('settings.apiKey')}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.settings?.apiKey ? 'border-destructive' : 'border-border'
            }`}
          />
          {errors.settings?.apiKey && (
            <p className="text-sm text-destructive mt-1">{errors.settings.apiKey.message}</p>
          )}
        </div>
      )}

      {fields.useSsl && (
        <div className="sm:col-span-2">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              {...register('settings.useSsl')}
              className="w-5 h-5 rounded border-border text-primary focus:ring-primary focus:ring-offset-0"
            />
            <span className="text-sm font-medium">Use SSL/HTTPS</span>
          </label>
        </div>
      )}

      <div className="sm:col-span-2">
        <label htmlFor="clientCategory" className="block text-sm font-medium mb-2">Category</label>
        <input
          id="clientCategory"
          type="text"
          {...register('settings.category')}
          className="w-full px-4 py-3 bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
          placeholder="audiobooks"
        />
        <p className="text-sm text-muted-foreground mt-1">Optional. Tags downloads so the client routes them to a dedicated folder.</p>
      </div>
    </>
  );
}
