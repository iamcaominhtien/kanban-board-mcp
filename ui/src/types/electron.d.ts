interface Window {
  electronAPI?: {
    getBackendPort: () => Promise<number | null>;
    selectFolder?: () => Promise<string | null>;
    openPath?: (filePath: string) => Promise<{ success: boolean; error?: string | null }>;
    openExternal?: (url: string) => Promise<{ success: boolean; error?: string }>;
    onBackendReady?: (callback: (port: number) => void) => () => void;
    onBackendError?: (callback: (message: string) => void) => () => void;
    retryBackend?: () => Promise<number>;
    platform: string;
  };
}
