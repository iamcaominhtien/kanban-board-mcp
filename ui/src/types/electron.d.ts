interface Window {
  electronAPI?: {
    getBackendPort: () => Promise<number | null>;
    platform: string;
  };
}
