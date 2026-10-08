interface UpdateInfo {
  version: string;
  notes: string;
  releaseUrl: string | null;
  assetName: string;
  assetSize: number;
}

interface Window {
  electronAPI?: {
    getBackendPort: () => Promise<number | null>;
    selectFolder?: () => Promise<string | null>;
    openPath?: (filePath: string) => Promise<{ success: boolean; error?: string | null }>;
    openExternal?: (url: string) => Promise<{ success: boolean; error?: string }>;
    onBackendReady?: (callback: (port: number) => void) => () => void;
    onBackendError?: (callback: (message: string) => void) => () => void;
    retryBackend?: () => Promise<number>;
    getUpdateInfo?: () => Promise<UpdateInfo | null>;
    checkForUpdate?: () => Promise<{ info: UpdateInfo | null; error?: string }>;
    downloadUpdate?: () => Promise<{ filePath?: string; error?: string }>;
    installUpdate?: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    onUpdateAvailable?: (callback: (info: UpdateInfo) => void) => () => void;
    onUpdateProgress?: (callback: (fraction: number) => void) => () => void;
    platform: string;
  };
}
