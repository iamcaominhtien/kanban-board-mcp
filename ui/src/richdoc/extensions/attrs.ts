/**
 * The rich attributes format 1 adds to node types the editor already had (schema.json): alignment, indent and
 * spacing on text blocks, list styles, code block options, image placement, table shading, callout colour and so on.
 * They are global attributes, so the existing extensions stay as they are; plain Markdown drops them (the text stays).
 */

import { Extension } from '@tiptap/core';
import { dataAttr, nullable } from './attr';

const textBlock = {
  textAlign: dataAttr('textAlign', null),
  indent: dataAttr('indent', 0, 'json'),
  lineHeight: dataAttr('lineHeight', null, 'json'),
  spaceBefore: dataAttr('spaceBefore', null, 'json'),
  spaceAfter: dataAttr('spaceAfter', null, 'json'),
};

/** Adds the format 1 attributes to paragraph, heading, quote, lists, code block, rule, table, image, callout, … */
export const RichAttrs = Extension.create({
  name: 'richdocAttrs',

  addGlobalAttributes() {
    return [
      {
        types: ['paragraph'],
        attributes: { ...textBlock, dropCap: dataAttr('dropCap', 0, 'json'), variant: dataAttr('variant', null) },
      },
      { types: ['heading'], attributes: textBlock },
      { types: ['blockquote'], attributes: { variant: dataAttr('variant', 'plain'), ...nullable('source') } },
      { types: ['bulletList', 'orderedList'], attributes: { listStyle: dataAttr('listStyle', null) } },
      {
        types: ['codeBlock'],
        attributes: {
          filename: dataAttr('filename', null),
          lineNumbers: dataAttr('lineNumbers', false, 'json'),
          wrap: dataAttr('wrap', false, 'json'),
          theme: dataAttr('theme', null),
          highlightLines: dataAttr('highlightLines', null),
          diff: dataAttr('diff', false, 'json'),
        },
      },
      { types: ['horizontalRule'], attributes: { style: dataAttr('style', 'line') } },
      { types: ['table'], attributes: { style: dataAttr('style', null), width: dataAttr('width', null) } },
      {
        types: ['tableCell', 'tableHeader'],
        attributes: { background: dataAttr('background', null), verticalAlign: dataAttr('verticalAlign', null) },
      },
      {
        types: ['image'],
        attributes: {
          placement: dataAttr('placement', 'block'),
          widthPct: dataAttr('widthPct', null, 'json'),
          wrapGap: dataAttr('wrapGap', 16, 'json'),
          caption: dataAttr('caption', null),
          href: dataAttr('href', null),
          crop: dataAttr('crop', null, 'json'),
          border: dataAttr('border', null),
          radius: dataAttr('radius', 0, 'json'),
          shadow: dataAttr('shadow', false, 'json'),
        },
      },
      {
        types: ['callout'],
        attributes: { ...nullable('color', 'icon'), style: dataAttr('style', 'soft'), title: dataAttr('title', null) },
      },
      {
        types: ['diagram'],
        attributes: { version: dataAttr('version', null, 'json'), widthPct: dataAttr('widthPct', null, 'json') },
      },
      { types: ['docRef'], attributes: nullable('pageId', 'targetBlockId', 'targetLabel') },
    ];
  },
});
