// @vitest-environment jsdom
/**
 * The Docs editor's schema matches server/contract/richdoc/schema.json: the same nodes and marks, the same attributes
 * with the same defaults, the same content, groups and inline-ness, both ways.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MARK_ORDER, editorSchema } from '.';

interface AttrSpec {
  default: unknown;
}
interface TypeSpec {
  group?: string;
  content?: string;
  inline?: boolean;
  attrs?: Record<string, AttrSpec> | string;
}
const contract = JSON.parse(readFileSync(join(__dirname, '../../../server/contract/richdoc/schema.json'), 'utf8')) as {
  nodes: Record<string, TypeSpec>;
  marks: Record<string, TypeSpec>;
};

/** Node types the editor has that schema.json does not need to describe. */
const BUILT_IN = new Set(['doc', 'text', 'hardBreak']);

const attrsOf = (spec: TypeSpec): Record<string, AttrSpec> => {
  if (typeof spec.attrs === 'string') {
    // "same as tableCell"
    const other = spec.attrs.replace(/^same as /, '');
    return attrsOf(contract.nodes[other]);
  }
  return spec.attrs ?? {};
};

const defaults = (attrs: Record<string, { default?: unknown }> | undefined) =>
  Object.fromEntries(Object.entries(attrs ?? {}).map(([k, v]) => [k, v.default]));

describe('editor schema = schema.json', () => {
  const schema = editorSchema();

  it('has the same node types', () => {
    const editor = Object.keys(schema.nodes).filter((n) => !BUILT_IN.has(n));
    const declared = Object.keys(contract.nodes).filter((n) => !BUILT_IN.has(n));
    expect(editor.sort()).toEqual(declared.sort());
  });

  for (const [name, spec] of Object.entries(contract.nodes)) {
    it(`node ${name}`, () => {
      const type = schema.nodes[name];
      expect(type, name).toBeDefined();
      expect(defaults(type.spec.attrs as never)).toEqual(defaults(attrsOf(spec)));
      if (spec.content) expect(type.spec.content).toBe(spec.content);
      if (spec.group) expect(type.spec.group).toBe(spec.group);
      expect(type.isInline).toBe(spec.group === 'inline');
    });
  }

  it('has the same marks, in the canonical order', () => {
    expect(Object.keys(schema.marks).sort()).toEqual(Object.keys(contract.marks).sort());
    expect([...MARK_ORDER]).toEqual(Object.keys(contract.marks));
  });

  for (const [name, spec] of Object.entries(contract.marks)) {
    it(`mark ${name}`, () => {
      expect(defaults(schema.marks[name]?.spec.attrs as never)).toEqual(defaults(attrsOf(spec)));
    });
  }
});
