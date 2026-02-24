import { useState, useEffect, useRef, useCallback } from 'react';
import type { UseFormGetValues } from 'react-hook-form';
import type { CreateDownloadClientFormData } from '../../../shared/schemas.js';
import { downloadClientsApi, type CategoriesResult } from '@/lib/api/download-clients';

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
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Clear state when type changes
  useEffect(() => {
    setCategories([]);
    setError(null);
    setShowDropdown(false);
  }, [selectedType]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch categories');
      setCategories([]);
      setShowDropdown(false);
    } finally {
      setFetching(false);
    }
  }, [clientId, isDirty, getValues]);

  return { fetching, categories, error, showDropdown, setShowDropdown, dropdownRef, fetchCategories };
}
