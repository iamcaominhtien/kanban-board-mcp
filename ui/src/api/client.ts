import axios from 'axios';
import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';
import { reportDatabaseUnreachable, unreachableOf } from './databaseDown';
import { resolveOrigin } from './resolveOrigin';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Leave the keys of the response as the server sent them (a dict keyed by ids such as "IAM-12"). */
    keepKeys?: boolean;
  }
}

/** Axios instance that converts keys between snake_case (API) and camelCase (UI). */
export const client = axios.create();

let apiSecret: string | null = null;

/** The secret the desktop app gave this window so the server accepts its changes (null: not in the app, or not set). */
export function apiSecretOf(): string | null {
  if (apiSecret === null) {
    try {
      apiSecret = window.electronAPI?.getApiSecret?.() || '';
    } catch {
      apiSecret = '';
    }
  }
  return apiSecret || null;
}

function isFormDataPayload(value: unknown): value is FormData {
  return typeof FormData !== 'undefined' && value instanceof FormData;
}

// Transform response keys: snake_case → camelCase. A 503 "database_unreachable" opens the reconnect screen.
client.interceptors.response.use(
  (response) => {
    if (response.data && typeof response.data === 'object' && !response.config?.keepKeys) {
      response.data = camelcaseKeys(response.data, { deep: true });
    }
    return response;
  },
  (error) => {
    const down = unreachableOf(error);
    if (down) reportDatabaseUnreachable(down);
    return Promise.reject(error);
  },
);

// Transform request bodies: camelCase → snake_case, and resolve baseURL per-request
client.interceptors.request.use((config) => {
  config.baseURL = resolveOrigin();
  const secret = apiSecretOf();
  if (secret) config.headers.set('X-Kanban-Secret', secret);
  // Act as a named project member (Docs comment roles); the board's own user is the default.
  try {
    const actor = localStorage.getItem('kanbanActor');
    if (actor) config.headers.set('X-Actor', actor);
  } catch {
    /* storage unavailable */
  }
  if (config.data && typeof config.data === 'object' && !isFormDataPayload(config.data)) {
    config.data = snakecaseKeys(config.data as Record<string, unknown>, { deep: true });
  }
  return config;
});
