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
      queryClient.refetchQueries({ queryKey: ['settings'] });
    },
  });
}

export interface McpClientStatus {
  id: 'claude-code' | 'antigravity';
  label: string;
  configPath: string;
  installed: boolean;
  upToDate: boolean;
  error: string | null;
}

export function useMcpClients() {
  return useQuery<McpClientStatus[]>({
    queryKey: ['settings', 'mcp-clients'],
    queryFn: async () => (await client.get('/settings/mcp-clients')).data,
  });
}

export function useSetMcpClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, install }: { id: string; install: boolean }) => {
      const res = install
        ? await client.post(`/settings/mcp-clients/${id}`)
        : await client.delete(`/settings/mcp-clients/${id}`);
      return res.data as McpClientStatus;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'mcp-clients'] }),
  });
}
