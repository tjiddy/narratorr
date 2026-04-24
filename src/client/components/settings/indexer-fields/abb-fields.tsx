import type { IndexerFieldsProps } from './types.js';
import { FlareSolverrField } from './flaresolverr-field.js';

export function AbbFields({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
  return (
    <>
      <div>
        <label htmlFor="indexerHostname" className="block text-sm font-medium mb-2">Hostname</label>
        <input
          id="indexerHostname"
          type="text"
          {...register('settings.hostname')}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
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
          step={1}
          className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
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
