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

interface AppCommandMessage {
  command: string;
  [key: string]: unknown;
}

interface AppInfo {
  appName: string;
  version: string;
  backendRunning: boolean;
  osName: string;
  osVersion: string;
  arch: string;
  electron: string;
  chrome: string;
  language: string;
  window?: number[] | null;
}

interface Window {
  electronAPI?: {
    getBackendPort: () => Promise<number | null>;
    /** The secret that lets this window change the board; the server refuses every other caller (server/api_secret.py). */
    getApiSecret?: () => string;
    selectFolder?: () => Promise<string | null>;
    openPath?: (filePath: string) => Promise<{ success: boolean; error?: string | null }>;
    showItemInFolder?: (filePath: string) => Promise<{ success: boolean; error?: string | null }>;
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
    /** A command from the application menu (Settings page, New Ticket, a window, a toast…). Desktop only. */
    onAppCommand?: (callback: (message: AppCommandMessage) => void) => () => void;
    /** Tells the menu which view is on screen, for its check mark. */
    setAppState?: (state: { view: string }) => void;
    /** Versions and system facts, for About and Report an Issue. */
    getAppInfo?: () => Promise<AppInfo>;
    /** Whether the computer is kept awake while an AI run is starting or running (View › Keep awake while AI runs). */
    getKeepAwake?: () => Promise<boolean>;
    /** Turn Keep awake while AI runs on or off; resolves to the new state. */
    setKeepAwake?: (on: boolean) => Promise<boolean>;
    platform: string;
  };
}
