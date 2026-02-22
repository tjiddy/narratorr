import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../shared/schemas.js';

interface IndexerFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateIndexerFormData>;
  errors: FieldErrors<CreateIndexerFormData>;
}

// eslint-disable-next-line complexity -- error display branches per field type are inherently branchy
export function IndexerFields({ selectedType, register, errors }: IndexerFieldsProps) {
  if (selectedType === 'abb') {
    return (
      <>
        <div>
          <label htmlFor="indexerHostname" className="block text-sm font-medium mb-2">Hostname</label>
          <input
            id="indexerHostname"
            type="text"
            {...register('settings.hostname')}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.settings?.hostname ? 'border-destructive' : 'border-border'
            }`}
            placeholder="audiobookbay.lu"
          />
          {errors.settings?.hostname ? (
            <p className="text-sm text-destructive mt-1">{errors.settings.hostname.message}</p>
          ) : (
            <p className="text-sm text-muted-foreground mt-1">Domain only, without http:// or https://</p>
          )}
        </div>
        <div>
          <label htmlFor="indexerPageLimit" className="block text-sm font-medium mb-2">Page Limit</label>
          <input
            id="indexerPageLimit"
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
      </>
    );
  }

  if (selectedType === 'torznab' || selectedType === 'newznab') {
    return (
      <>
        <div className="sm:col-span-2">
          <label htmlFor="indexerApiUrl" className="block text-sm font-medium mb-2">API URL</label>
          <input
            id="indexerApiUrl"
            type="text"
            {...register('settings.apiUrl')}
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.settings?.apiUrl ? 'border-destructive' : 'border-border'
            }`}
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
            className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
              errors.settings?.apiKey ? 'border-destructive' : 'border-border'
            }`}
          />
          {errors.settings?.apiKey && (
            <p className="text-sm text-destructive mt-1">{errors.settings.apiKey.message}</p>
          )}
        </div>
      </>
    );
  }

  return null;
}
