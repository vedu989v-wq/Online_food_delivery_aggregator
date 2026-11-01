import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/** Keep non-sensitive page preferences when a user leaves and returns within the same tab. */
export function useSessionState<T>(key: string, initialValue: T | (() => T), validate?: (value: unknown) => T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = sessionStorage.getItem(key);
      if (saved !== null) {
        const parsed: unknown = JSON.parse(saved);
        return validate ? validate(parsed) : parsed as T;
      }
    } catch { /* Use the supplied default when storage is unavailable or invalid. */ }
    return typeof initialValue === 'function' ? (initialValue as () => T)() : initialValue;
  });

  useEffect(() => {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* The page remains usable when storage is unavailable. */ }
  }, [key, value]);

  return [value, setValue];
}
