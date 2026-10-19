import { Select } from '@mantine/core';
import type { AxiosInstance } from 'axios';
import { useEffect, useState } from 'react';

interface NativeLocation {
  pk?: number;
  id?: number;
  name: string;
  pathstring?: string;
  parent?: number | { pk?: number; id?: number } | null;
  structural?: boolean;
}

interface NativeLocationPickerProps {
  api?: AxiosInstance;
  value: number | null;
  onChange: (value: number | null) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  clearable?: boolean;
  structural?: boolean;
  parentId?: number | null;
}

/** Named selector backed by InvenTree's native StockLocation list endpoint. */
export function NativeLocationPicker({
  api,
  value,
  onChange,
  label,
  description,
  disabled,
  clearable = true,
  structural,
  parentId
}: NativeLocationPickerProps) {
  const [locations, setLocations] = useState<NativeLocation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setError(null);
    setLocations([]);
    if (!api)
      return () => {
        active = false;
      };
    setLoading(true);

    const load = async () => {
      try {
        const all: NativeLocation[] = [];
        let url = '/api/stock/location/';
        let params: Record<string, number> | undefined = { limit: 1000 };
        const visited = new Set<string>();
        while (url && !visited.has(url)) {
          visited.add(url);
          const response = await api.get(url, { params });
          params = undefined;
          const rows = Array.isArray(response.data)
            ? response.data
            : response.data?.results;
          if (Array.isArray(rows)) all.push(...rows);
          const next = response.data?.next;
          if (!next) break;
          const nextUrl = new URL(
            next,
            api.defaults.baseURL || window.location.origin
          );
          const base = new URL(
            api.defaults.baseURL || window.location.origin,
            window.location.origin
          );
          if (nextUrl.origin !== base.origin)
            throw new Error('Unexpected pagination origin');
          url = `${nextUrl.pathname}${nextUrl.search}`;
        }
        if (active) setLocations(all);
      } catch {
        if (active)
          setError(
            'Could not load all stock locations. Check access and retry.'
          );
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [api]);

  const options = locations.flatMap((location) => {
    const id = location.pk ?? location.id;
    const parent =
      typeof location.parent === 'object' && location.parent !== null
        ? (location.parent.pk ?? location.parent.id ?? null)
        : (location.parent ?? null);
    if (
      typeof id !== 'number' ||
      (id !== value &&
        structural !== undefined &&
        location.structural !== structural) ||
      (id !== value && parentId !== undefined && parent !== parentId)
    ) {
      return [];
    }
    return [{ value: String(id), label: location.pathstring || location.name }];
  });

  return (
    <Select
      label={label}
      description={
        error ?? (loading ? 'Loading stock locations…' : description)
      }
      data={options}
      value={value === null ? null : String(value)}
      onChange={(next) => onChange(next === null ? null : Number(next))}
      searchable
      clearable={clearable}
      disabled={disabled || loading}
      nothingFoundMessage={error ?? 'No stock locations found'}
      comboboxProps={{ withinPortal: true }}
    />
  );
}
