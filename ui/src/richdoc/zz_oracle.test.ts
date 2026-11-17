// @vitest-environment jsdom
// TEMPORARY oracle for kb-richdoc development; delete before finishing.
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { docToMarkdown, docToText, markdownToDoc, seqIds } from '.';

it('oracle', () => {
  const inp = process.env.ORACLE_IN;
  if (!inp) return;
  const reqs = JSON.parse(readFileSync(inp, 'utf8')) as { op: string; md?: string; doc?: unknown }[];
  const out = reqs.map((r) => {
    try {
      if (r.op === 'md') {
        const doc = markdownToDoc(r.md!, seqIds());
        return { doc, md: docToMarkdown(doc), txt: docToText(doc) };
      }
      return { md: docToMarkdown(r.doc as never), txt: docToText(r.doc as never) };
    } catch (e) {
      return { error: String(e) };
    }
  });
  writeFileSync(process.env.ORACLE_OUT!, JSON.stringify(out, null, 1));
});
