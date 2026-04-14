import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { client } from './client';

export interface SettingsData {
  dbPath: string;
  dataFolder: string;
  uploadsDir: string;
}

function mapSettings(raw: Record<string, string>): SettingsData {
  return {
    dbPath: raw.dbPath,
    dataFolder: raw.dataFolder,
    uploadsDir: raw.uploadsDir,
  };
}

export function useSettings() {
  return useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await client.get('/settings');
      return mapSettings(res.data);
    },
  });
}

export function useSetDataPath() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (path: string) => {
      const res = await client.post('/settings/data-path', { path });
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}
