/**
 * Opening one setting from AI Team (a Health fix item: "Open Memory of one run"). Like the run link, a request made
 * inside the app travels as an event; the App opens the settings page on that page and highlights that setting.
 */

export const OPEN_SETTINGS_EVENT = 'kanban:open-settings';

export interface SettingsLink {
  page: string;
  setting?: string;
}

/** Ask the app to open a settings page, scrolled to one setting. */
export function openSettingsAt(link: SettingsLink): void {
  window.dispatchEvent(new CustomEvent<SettingsLink>(OPEN_SETTINGS_EVENT, { detail: link }));
}
