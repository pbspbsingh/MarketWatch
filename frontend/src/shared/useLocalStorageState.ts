import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

interface LocalStorageStateOptions<T> {
  serialize?: (value: T) => string | null;
  deserialize?: (value: string) => T;
}

export function useLocalStorageState<T>(
  key: string,
  initialValue: T | (() => T),
  options: LocalStorageStateOptions<T> = {},
): [T, Dispatch<SetStateAction<T>>] {
  const { serialize = JSON.stringify, deserialize = JSON.parse as (value: string) => T } = options;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return deserialize(stored);
    } catch {}
    return typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
  });

  useEffect(() => {
    try {
      const serialized = serialize(value);
      if (serialized === null) localStorage.removeItem(key);
      else localStorage.setItem(key, serialized);
    } catch {}
  }, [key, serialize, value]);

  return [value, setValue];
}
