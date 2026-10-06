import { Extension } from '@tiptap/core';

export interface ShortcutOptions {
  onLink: () => void;
}

/** The board's keyboard shortcuts that StarterKit does not already provide. */
export const Shortcuts = Extension.create<ShortcutOptions>({
  name: 'docsShortcuts',
  priority: 200,
  addOptions() {
    return { onLink: () => {} };
  },
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-x': () => this.editor.commands.toggleStrike(),
      'Mod-e': () => this.editor.commands.toggleCode(),
      'Mod-k': () => {
        this.options.onLink();
        return true;
      },
      'Mod-Alt-1': () => this.editor.commands.toggleHeading({ level: 1 }),
      'Mod-Alt-2': () => this.editor.commands.toggleHeading({ level: 2 }),
      'Mod-Alt-3': () => this.editor.commands.toggleHeading({ level: 3 }),
      'Mod-Shift-7': () => this.editor.commands.toggleOrderedList(),
      'Mod-Shift-8': () => this.editor.commands.toggleBulletList(),
      'Mod-Shift-9': () => this.editor.commands.toggleTaskList(),
      'Mod-Shift-b': () => this.editor.commands.toggleBlockquote(),
      'Mod-Alt-c': () => this.editor.commands.toggleCodeBlock(),
    };
  },
});
