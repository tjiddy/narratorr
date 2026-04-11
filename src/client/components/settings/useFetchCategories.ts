import { useState, useEffect, useCallback } from 'react';
import type { UseFormGetValues } from 'react-hook-form';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';
import { downloadClientsApi, type CategoriesResult } from '@/lib/api/download-clients';
import { getErrorMessage } from '@/lib/error-message.js';

interface UseFetchCategoriesOptions {
  selectedType: string;
  clientId?: number;
  isDirty?: boolean;
  getValues: UseFormGetValues<CreateDownloadClientFormData>;
}

export function useFetchCategories({ selectedType, clientId, isDirty, getValues }: UseFetchCategoriesOptions) {
  const [fetching, setFetching] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);

  // Clear state when type changes
  useEffect(() => {
    setCategories([]);
    setError(null);
    setShowDropdown(false);
  }, [selectedType]);

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
      setError(getErrorMessage(error, 'Failed to fetch categories'));
      setCategories([]);
      setShowDropdown(false);
    } finally {
      setFetching(false);
    }
  }, [clientId, isDirty, getValues]);

  return { fetching, categories, error, showDropdown, setShowDropdown, fetchCategories };
}
