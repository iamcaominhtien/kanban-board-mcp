import axios from 'axios';
import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';

async function getBaseURL(): Promise<string> {
  if (typeof window !== 'undefined' && window.electronAPI?.getBackendPort) {
    const port = await window.electronAPI.getBackendPort();
    if (port) return `http://127.0.0.1:${port}`;
  }
  return import.meta.env.VITE_API_URL ?? 'http://localhost:8000';
}

export const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? 'http://localhost:8000',
});

// Lazily update baseURL once we know the Electron backend port
getBaseURL().then((url) => {
  client.defaults.baseURL = url;
});

// Transform response keys: snake_case → camelCase
client.interceptors.response.use((response) => {
  if (response.data && typeof response.data === 'object') {
    response.data = camelcaseKeys(response.data, { deep: true });
  }
  return response;
});

// Transform request bodies: camelCase → snake_case
client.interceptors.request.use((config) => {
  if (config.data && typeof config.data === 'object') {
    config.data = snakecaseKeys(config.data as Record<string, unknown>, { deep: true });
  }
  return config;
});

