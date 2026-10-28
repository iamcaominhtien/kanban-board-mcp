interface UpdateInfo {
  version: string;
  notes: string;
  releaseUrl: string | null;
  assetName: string;
  assetSize: number;
  /** Set when the info comes from a check the user started from Settings. */
  manual?: boolean;
}

interface UpdateCheckResult {
  at: string;
  error: string | null;
}

interface UpdateStatus {
  currentVersion: string;
  lastCheck: UpdateCheckResult | null;
  info: UpdateInfo | null;
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
    getUpdateStatus?: () => Promise<UpdateStatus>;
    checkForUpdate?: () => Promise<{ info: UpdateInfo | null; lastCheck: UpdateCheckResult | null; error?: string }>;
    openReleasesPage?: () => Promise<void>;
    downloadUpdate?: () => Promise<{ filePath?: string; error?: string }>;
    installUpdate?: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    onUpdateAvailable?: (callback: (info: UpdateInfo) => void) => () => void;
    onUpdateProgress?: (callback: (fraction: number) => void) => () => void;
    platform: string;
  };
}
