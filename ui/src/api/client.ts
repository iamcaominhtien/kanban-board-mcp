import axios from 'axios';
import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';
import { resolveOrigin } from './resolveOrigin';

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

// Transform response keys: snake_case → camelCase
client.interceptors.response.use((response) => {
  if (response.data && typeof response.data === 'object') {
    response.data = camelcaseKeys(response.data, { deep: true });
  }
  return response;
});

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
