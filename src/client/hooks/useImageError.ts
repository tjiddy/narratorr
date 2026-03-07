import { useState } from 'react';

export function useImageError() {
  const [hasError, setHasError] = useState(false);
  const onError = () => setHasError(true);
  const reset = () => setHasError(false);
  return { hasError, onError, reset };
}
