import axios from 'axios';
import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';
import { resolveOrigin } from './resolveOrigin';

export const client = axios.create();

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
  if (config.data && typeof config.data === 'object' && !isFormDataPayload(config.data)) {
    config.data = snakecaseKeys(config.data as Record<string, unknown>, { deep: true });
  }
  return config;
});
