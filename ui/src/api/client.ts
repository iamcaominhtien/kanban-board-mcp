import axios from 'axios';
import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';

let baseURLPromise: Promise<string> | null = null;

function resolveBaseURL(): Promise<string> {
  if (!baseURLPromise) {
    baseURLPromise = (async () => {
      if (typeof window !== 'undefined' && window.electronAPI?.getBackendPort) {
        const port = await window.electronAPI.getBackendPort();
        if (port) return `http://127.0.0.1:${port}`;
      }
      return import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000';
    })();
  }
  return baseURLPromise;
}

export const client = axios.create();

// Transform response keys: snake_case → camelCase
client.interceptors.response.use((response) => {
  if (response.data && typeof response.data === 'object') {
    response.data = camelcaseKeys(response.data, { deep: true });
  }
  return response;
});

// Transform request bodies: camelCase → snake_case, and resolve baseURL per-request
client.interceptors.request.use(async (config) => {
  config.baseURL = await resolveBaseURL();
  if (config.data && typeof config.data === 'object') {
    config.data = snakecaseKeys(config.data as Record<string, unknown>, { deep: true });
  }
  return config;
});

