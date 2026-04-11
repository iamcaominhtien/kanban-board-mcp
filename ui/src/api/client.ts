import axios from 'axios';
import camelcaseKeys from 'camelcase-keys';
import snakecaseKeys from 'snakecase-keys';
import { resolveOrigin } from './resolveOrigin';

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
  config.baseURL = await resolveOrigin();
  if (config.data && typeof config.data === 'object') {
    config.data = snakecaseKeys(config.data as Record<string, unknown>, { deep: true });
  }
  return config;
});
