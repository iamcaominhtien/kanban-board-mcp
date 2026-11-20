/**
 * One helper for the rich attributes of format 1: an attribute with its schema default, written to HTML as a
 * `data-*` attribute (only when it is not at its default) and read back from it, so it survives copy and paste as
 * well as getJSON / setContent.
 */

import type { Attribute } from '@tiptap/core';

/** How the value is written in its `data-*` attribute: as is (`string`) or as JSON (numbers, booleans, objects). */
export type AttrKind = 'string' | 'json';

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * A TipTap attribute spec.
 * @param name - The attribute name (`widthPct` is written `data-width-pct`).
 * @param def - The default from schema.json.
 * @param kind - `string` for string attributes, `json` for every other type.
 */
export function dataAttr(name: string, def: unknown, kind: AttrKind = 'string'): Attribute {
  const html = `data-${kebab(name)}`;
  return {
    default: def,
    parseHTML: (el) => {
      const raw = el.getAttribute(html);
      if (raw === null) return def;
      if (kind === 'string') return raw;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return def;
      }
    },
    renderHTML: (attrs) => {
      const v = attrs[name] as unknown;
      if (v === null || v === undefined || JSON.stringify(v) === JSON.stringify(def)) return {};
      return { [html]: kind === 'string' ? String(v) : JSON.stringify(v) };
    },
  };
}

/** Several string-or-null attributes at once (`default: null`). */
export function nullable(...names: string[]): Record<string, Attribute> {
  return Object.fromEntries(names.map((n) => [n, dataAttr(n, null)]));
}

/**
 * The `data-*` entries of a node's rendered attributes: for nodes that draw their own element, so the format 1
 * attributes (`data-block-id`, `data-width-pct`…) reach the HTML without their own attributes (`id`, `label`) as
 * plain HTML attributes.
 */
export function dataOnly(attrs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')));
}
