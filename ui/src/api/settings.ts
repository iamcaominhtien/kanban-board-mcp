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

/** Query the app settings. */
export function useSettings() {
  return useQuery<SettingsData>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await client.get('/settings');
      return mapSettings(res.data);
    },
  });
}

/** Mutation: change the data folder. */
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

export type McpClientId = 'claude-code' | 'antigravity';

export interface McpClientStatus {
  id: McpClientId;
  scope: string;
  needsFolder: boolean;
  toolCount: number;
  detected: boolean;
  installed: boolean;
  updateAvailable: boolean;
  installedCommand: string | null;
  command: string | null;
  entryJson: string | null;
  storedIn: string | null;
  error: { code: string; message: string } | null;
}

export interface McpTestResult {
  ok: boolean;
  toolCount: number;
  message: string;
}

export interface McpTarget {
  id: McpClientId;
  scope: string;
  folder: string;
}

const mcpKey = (t: McpTarget) => ['settings', 'mcp-client', t.id, t.scope, t.folder];

/** Query an MCP client's install status. */
export function useMcpClient(target: McpTarget) {
  return useQuery<McpClientStatus>({
    queryKey: mcpKey(target),
    queryFn: async () =>
      (
        await client.get(`/settings/mcp-clients/${target.id}`, {
          params: { scope: target.scope, folder: target.folder || undefined },
        })
      ).data,
    // A missing project folder is a form state, not something to retry.
    retry: false,
  });
}

/** Mutation: install or remove the MCP server for a client. */
export function useMcpAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, action }: { target: McpTarget; action: 'install' | 'remove' }) =>
      (
        await client.post(`/settings/mcp-clients/${target.id}/${action}`, {
          scope: target.scope,
          folder: target.folder || null,
        })
      ).data as McpClientStatus,
    onSuccess: (status, { target }) => queryClient.setQueryData(mcpKey(target), status),
  });
}

/** Mutation: test the MCP connection. */
export function useMcpTest() {
  return useMutation({
    mutationFn: async (target: McpTarget) =>
      (
        await client.post(`/settings/mcp-clients/${target.id}/test`, {
          scope: target.scope,
          folder: target.folder || null,
        })
      ).data as McpTestResult,
  });
}

/** Open a client's MCP config file in the OS editor. */
export async function openMcpConfigFile(target: McpTarget) {
  await client.post(`/settings/mcp-clients/${target.id}/open-file`, {
    scope: target.scope,
    folder: target.folder || null,
  });
}
