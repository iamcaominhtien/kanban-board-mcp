/** Plugins and skills installed from a source, and the catalogue of suggestions (design/screens/ai-team-process.md, B). */
export type SourceKind = 'git' | 'marketplace' | 'folder';

export interface PluginUsage {
  uses: number;
  /** Uses per member (a list, so the client's key casing never touches a member id). */
  byMember: { memberId: string; uses: number }[];
  last: string | null;
}

export interface Plugin {
  id: string;
  projectId: string;
  name: string;
  sourceKind: SourceKind;
  source: string;
  ref: string | null;
  plugin: string | null;
  commit: string | null;
  version: string | null;
  description: string | null;
  skills: string[];
  hooks: unknown[] | number | null;
  mcp: unknown[] | number | null;
  sizeBytes: number | null;
  pinned: boolean;
  defaultOn: boolean;
  roles: string[];
  /** Per-member switches; a member without an entry follows the default. */
  members: { memberId: string; on: boolean }[];
  hasPrevious: boolean;
  installedBy: string | null;
  installedAt: string | null;
  updatedAt: string | null;
  used: PluginUsage;
}

export interface CatalogueEntry {
  key: string;
  name: string;
  kind: 'plugin' | 'mcp';
  source?: string;
  plugin?: string;
  skills?: string[];
  server?: unknown;
  roles: string[];
  what: string;
}

export interface SourceBody {
  sourceKind: SourceKind;
  source: string;
  ref?: string;
  plugin?: string;
  skills?: string[];
}

export interface PluginPreview {
  name: string;
  version: string | null;
  description: string | null;
  skills: string[];
  hooks: unknown[] | number | null;
  mcp: unknown[] | number | null;
  sizeBytes: number | null;
  commit: string | null;
}

export interface PreviewChoices {
  choices: { name: string; description: string | null }[];
}

export interface UpdateCheck {
  update: boolean;
  latest?: string | null;
  current?: string | null;
  pinned?: boolean;
}

export interface PluginChanges {
  commit: string | null;
  added: string[];
  removed: string[];
  changed: string[];
}

export type PluginAction = 'update' | 'rollback' | 'reload' | 'reset' | 'pin' | 'unpin';
