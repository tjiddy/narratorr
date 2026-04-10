export const inputClass = 'w-full px-4 py-3 bg-background border border-border rounded-xl focus-ring focus:border-transparent transition-all';

export const compactInputClass = 'w-full px-3 py-2 bg-background border border-border rounded-lg focus-ring';

export function errorInputClass(hasError: boolean): string {
  return `w-full px-4 py-3 bg-background border rounded-xl focus-ring focus:border-transparent transition-all ${hasError ? 'border-destructive' : 'border-border'}`;
}
