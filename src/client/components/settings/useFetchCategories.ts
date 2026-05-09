import { useState, useCallback } from 'react';
import type { UseFormGetValues } from 'react-hook-form';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';
import { downloadClientsApi, type CategoriesResult } from '@/lib/api/download-clients';
import { getErrorMessage } from '@/lib/error-message.js';

interface UseFetchCategoriesOptions {
  clientId?: number | undefined;
  isDirty?: boolean | undefined;
  getValues: UseFormGetValues<CreateDownloadClientFormData>;
}

export function useFetchCategories({ clientId, isDirty, getValues }: UseFetchCategoriesOptions) {
  const [fetching, setFetching] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  const fetchCategories = useCallback(async () => {
    setFetching(true);
    setError(null);

    try {
      let result: CategoriesResult;

      if (clientId && !isDirty) {
        result = await downloadClientsApi.getClientCategories(clientId);
      } else {
        const formData = getValues();
        result = await downloadClientsApi.getClientCategoriesFromConfig({
          name: formData.name || 'temp',
          type: formData.type,
          enabled: formData.enabled,
          priority: formData.priority,
          settings: formData.settings,
          // Forward the editing client's id so the route can resolve any masked
          // secret (e.g. apiKey/password) against the persisted record. Omit
          // for create-mode so the route validates as plaintext-only.
          ...(clientId !== undefined ? { id: clientId } : {}),
        });
      }

      if (result.error) {
        setError(result.error);
        setCategories([]);
        setShowDropdown(false);
      } else {
        setCategories(result.categories);
        setError(null);
        setShowDropdown(true);
      }
    } catch (error: unknown) {
      setError(getErrorMessage(error));
      setCategories([]);
      setShowDropdown(false);
    } finally {
      setFetching(false);
    }
  }, [clientId, isDirty, getValues]);

  return { fetching, categories, error, showDropdown, setShowDropdown, fetchCategories };
}
