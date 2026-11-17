/**
 * The editor's link mark with the attributes of schema.json only (`href`, `title`). `target` and `rel` are still
 * written on every `<a>` from the options, but are no longer stored on each link. StarterKit does not export its
 * `Link`, and the package is not a direct dependency of the UI, so the extension is taken from a configured kit.
 */

import { flattenExtensions, type AnyExtension, type Attribute, type Mark } from '@tiptap/core';
import StarterKit, { type StarterKitOptions } from '@tiptap/starter-kit';

/**
 * The `link` mark configured with `options`, keeping only `href` (default `''`) and `title`.
 * @param options - The StarterKit `link` options.
 */
export function richLink(options: NonNullable<StarterKitOptions['link']>): AnyExtension {
  const base = flattenExtensions([StarterKit.configure({ link: options })]).find((e) => e.name === 'link') as
    Mark | undefined;
  if (!base) throw new Error('StarterKit has no link extension');
  return base.extend({
    addAttributes() {
      const parent = (this.parent?.() ?? {}) as Record<string, Attribute>;
      return { href: { ...parent.href, default: '' }, title: parent.title ?? { default: null } };
    },
  });
}
