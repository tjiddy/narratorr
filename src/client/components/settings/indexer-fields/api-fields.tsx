import type { IndexerFieldsProps } from './types.js';
import { FlareSolverrField } from './flaresolverr-field.js';

export function ApiFields({ register, errors, selectedType, prowlarrManaged }: Pick<IndexerFieldsProps, 'register' | 'errors'> & { selectedType: string; prowlarrManaged?: boolean }) {
  const readOnlyClass = prowlarrManaged ? 'opacity-60 cursor-not-allowed' : '';
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="indexerApiUrl" className="block text-sm font-medium mb-2">API URL</label>
        <input
          id="indexerApiUrl"
          type="text"
          {...register('settings.apiUrl')}
          readOnly={prowlarrManaged}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.apiUrl ? 'border-destructive' : 'border-border'
          } ${readOnlyClass}`}
          placeholder="https://indexer.example.com/api"
        />
        {errors.settings?.apiUrl ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.apiUrl.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Full URL to the {selectedType} API endpoint</p>
        )}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="indexerApiKey" className="block text-sm font-medium mb-2">API Key</label>
        <input
          id="indexerApiKey"
          type="password"
          {...register('settings.apiKey')}
          readOnly={prowlarrManaged}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
            errors.settings?.apiKey ? 'border-destructive' : 'border-border'
          } ${readOnlyClass}`}
        />
        {errors.settings?.apiKey && (
          <p className="text-sm text-destructive mt-1">{errors.settings.apiKey.message}</p>
        )}
      </div>
      <FlareSolverrField register={register} errors={errors} />
    </>
  );
}
