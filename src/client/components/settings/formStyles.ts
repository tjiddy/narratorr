export const inputClass = 'w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all';

export const compactInputClass = 'w-full px-3 py-2 bg-background border border-border rounded-lg focus-ring';

export function errorInputClass(hasError: boolean): string {
  return `w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${hasError ? 'border-destructive' : 'border-border'}`;
}

export const btnSecondary = 'px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50';
