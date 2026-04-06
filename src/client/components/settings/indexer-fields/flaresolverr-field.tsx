import type { IndexerFieldsProps } from './types.js';

export function FlareSolverrField({ register, errors }: Pick<IndexerFieldsProps, 'register' | 'errors'>) {
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
        className={`w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${
          errors.settings?.flareSolverrUrl ? 'border-destructive' : 'border-border'
        }`}
        placeholder="http://flaresolverr:8191"
      />
      {errors.settings?.flareSolverrUrl ? (
        <p className="text-sm text-destructive mt-1">{errors.settings.flareSolverrUrl.message}</p>
      ) : (
        <p className="text-sm text-muted-foreground mt-1">Improves reliability at the cost of performance. Routes requests through FlareSolverr/Byparr to bypass Cloudflare.</p>
      )}
    </div>
  );
}
