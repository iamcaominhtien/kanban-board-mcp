// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import { buildExtensions } from '../extensions';
import { withBlockViews } from './nodeViews';

const opts = { isTicket: () => false, onLink: () => {} };

/** The schema as data: every node's attributes with their defaults, content and group. */
function shape(ed: Editor) {
  const out: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(ed.schema.nodes)) {
    const attrs = Object.fromEntries(
      Object.entries(type.spec.attrs ?? {}).map(([k, v]) => [k, (v as { default?: unknown }).default]),
    );
    out[name] = { attrs, content: type.spec.content ?? null, group: type.spec.group ?? null, inline: !!type.isInline };
  }
  return out;
}

describe('withBlockViews', () => {
  it('keeps the schema exactly as buildExtensions makes it (schema.json is the contract)', () => {
    const plain = new Editor({ extensions: buildExtensions(opts) });
    const viewed = new Editor({ extensions: withBlockViews(buildExtensions(opts)) });
    expect(shape(viewed)).toEqual(shape(plain));
    expect(viewed.schema.nodes.image.isInline).toBe(false);
    expect(viewed.can().setHorizontalRule()).toBe(true);
    plain.destroy();
    viewed.destroy();
  });
});
