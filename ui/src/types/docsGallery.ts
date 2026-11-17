/** The New page gallery (design "Starting and shaping a page", B and D): templates built in and saved by people. */

/** Where a template is listed: the chips of the gallery (`yours` is a chip of its own, not a category). */
export type TemplateCategory = 'work' | 'ba' | 'writing';

/** What a saved template keeps of the page it was made from. */
export type TemplateKeeps = 'content' | 'structure' | 'style';

/** Who can start a page from a saved template. */
export type TemplateScope = 'me' | 'project';

/** A template that comes with the app (`GET /projects/{id}/docs/gallery` → `builtin`). */
export interface GalleryBuiltin {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** Page settings the new page starts with. */
  settings: Record<string, unknown>;
  /** The first characters of its Markdown. */
  preview: string;
}

/** A template a person saved from a page (`yours` and `project` of the gallery). */
export interface GallerySaved {
  id: string;
  name: string;
  description: string | null;
  category: TemplateCategory | null;
  keeps: TemplateKeeps;
  scope: TemplateScope;
  owner: string;
  /** The template is the caller's own (they can rename, share or delete it). */
  mine: boolean;
  usedCount: number;
  createdAt: string;
  updatedAt: string;
  settings: Record<string, unknown> | null;
  /** The first characters of its plain text. */
  preview: string;
}

/** `GET /projects/{id}/docs/gallery`. */
export interface DocsGallery {
  builtin: GalleryBuiltin[];
  /** The caller's own templates (only theirs, or shared with the project). */
  yours: GallerySaved[];
  /** Templates other people shared with the project. */
  project: GallerySaved[];
  /** The template the New page dialog starts on. */
  defaultTemplate: string;
  /** Built-in templates the project hides. */
  hidden: string[];
}

/** What "Save as template…" sends (`POST /projects/{id}/docs/gallery`). */
export interface TemplateSaveRequest {
  pageId: string;
  name: string;
  description?: string;
  category?: TemplateCategory | null;
  keeps: TemplateKeeps;
  scope: TemplateScope;
  /** Overwrite the caller's template of the same name (after a 409 `name_taken`). */
  replace?: boolean;
}
