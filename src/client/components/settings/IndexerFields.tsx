import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { CreateIndexerFormData } from '../../../shared/schemas.js';

interface IndexerFieldsProps {
  selectedType: string;
  register: UseFormRegister<CreateIndexerFormData>;
  errors: FieldErrors<CreateIndexerFormData>;
}

type FieldComponent = (props: Pick<IndexerFieldsProps, 'register' | 'errors'> & { selectedType: string }) => JSX.Element;

function FlareSolverrField({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
  return (
    <div className="sm:col-span-2">
      <label htmlFor="indexerFlareSolverrUrl" className="block text-sm font-medium mb-2">
        FlareSolverr URL
        <span className="text-muted-foreground font-normal ml-1">(optional)</span>
      </label>
      <input
        id="indexerFlareSolverrUrl"
        type="text"
        {...register('settings.flareSolverrUrl')}
        className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
          errors.settings?.flareSolverrUrl ? 'border-destructive' : 'border-border'
        }`}
        placeholder="http://flaresolverr:8191"
      />
      {errors.settings?.flareSolverrUrl ? (
        <p className="text-sm text-destructive mt-1">{errors.settings.flareSolverrUrl.message}</p>
      ) : (
        <p className="text-sm text-muted-foreground mt-1">Route requests through FlareSolverr/Byparr to bypass Cloudflare</p>
      )}
    </div>
  );
}

function AbbFields({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
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
      <FlareSolverrField register={register} errors={errors} />
    </>
  );
}

function ApiFields({ register, errors, selectedType }: Pick<IndexerFieldsProps, 'register' | 'errors'> & { selectedType: string }) {
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
      <FlareSolverrField register={register} errors={errors} />
    </>
  );
}

function MamFields({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
  return (
    <>
      <div className="sm:col-span-2">
        <label htmlFor="indexerMamId" className="block text-sm font-medium mb-2">MAM ID</label>
        <input
          id="indexerMamId"
          type="password"
          {...register('settings.mamId')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.settings?.mamId ? 'border-destructive' : 'border-border'
          }`}
        />
        {errors.settings?.mamId ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.mamId.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Generate from MAM &gt; Preferences &gt; Security &gt; Create Session</p>
        )}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="indexerBaseUrl" className="block text-sm font-medium mb-2">
          Base URL
          <span className="text-muted-foreground font-normal ml-1">(optional)</span>
        </label>
        <input
          id="indexerBaseUrl"
          type="text"
          {...register('settings.baseUrl')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all ${
            errors.settings?.baseUrl ? 'border-destructive' : 'border-border'
          }`}
          placeholder="https://www.myanonamouse.net"
        />
        {errors.settings?.baseUrl ? (
          <p className="text-sm text-destructive mt-1">{errors.settings.baseUrl.message}</p>
        ) : (
          <p className="text-sm text-muted-foreground mt-1">Only change if using a custom MAM mirror</p>
        )}
      </div>
    </>
  );
}

const FIELD_COMPONENTS: Record<string, FieldComponent> = {
  abb: AbbFields,
  torznab: ApiFields,
  newznab: ApiFields,
  myanonamouse: MamFields,
};

export function IndexerFields({ selectedType, register, errors }: IndexerFieldsProps) {
  const Component = FIELD_COMPONENTS[selectedType];
  if (!Component) return null;
  return <Component register={register} errors={errors} selectedType={selectedType} />;
}
