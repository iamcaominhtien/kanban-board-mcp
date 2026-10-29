/** Name, description and the rest of the simple `key: value` front matter of a SKILL.md / agent file. */
export function frontMatter(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { fields, body: text.slice(m[0].length) };
}

/** A starting SKILL.md. */
export function skillTemplate(name = 'my-skill'): string {
  return `---\nname: ${name}\ndescription: What this skill does and when to use it.\n---\n1. \n`;
}

/** A starting subagent file. */
export function agentTemplate(name = 'code-reviewer'): string {
  return `---\nname: ${name}\ndescription: Reviews a diff for bugs and style. Read-only tools.\ntools: Read, Grep, Glob\nmodel: sonnet\n---\nYou review changes. Report blocking issues first.\n`;
}

/** Split a command line into words, honouring simple quotes (for “npx -y server” and extra CLI flags). */
export function splitWords(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Join words back into a line, quoting those with spaces. */
export function joinWords(words: string[]): string {
  return words.map((w) => (/\s/.test(w) ? `"${w}"` : w)).join(' ');
}
