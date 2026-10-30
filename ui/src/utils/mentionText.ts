/**
 * A comment box shows a mention as `@PM`; the saved comment keeps `@[PM](member:id)` so it stays linked to the member
 * (a rename, two people with one first name). These turn one into the other.
 */

export interface MentionRef {
  id: string;
  name: string;
}

const STORED = /@\[([^\][\n]{1,100})\]\(member:([\w.-]{1,64})\)/g;
const WORD = /[\p{L}\p{N}_]/u;

/** `@[PM](member:id)` → `@PM`, for the text a person edits. */
export function toFriendly(text: string): string {
  return text.replace(STORED, '@$1');
}

/** Who the stored mentions in a text are (kept when editing, so a member renamed or removed since keeps the link). */
export function mentionRefs(text: string): MentionRef[] {
  return [...text.matchAll(STORED)].map((m) => ({ name: m[1], id: m[2] }));
}

/**
 * `@PM` → `@[PM](member:id)` for every typed or picked name of a member (whole name, any letter case, longest name first;
 * not inside a word such as an e-mail address, and not when more letters follow, so `@PMO` is not `@PM` + `O`).
 */
export function toStored(text: string, members: MentionRef[]): string {
  if (!text.includes('@') || members.length === 0) return text;
  const sorted = [...members].filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const before = i > 0 ? text[i - 1] : '';
    if (ch !== '@' || text[i + 1] === '[' || (before && WORD.test(before))) {
      out += ch;
      i += 1;
      continue;
    }
    const rest = text.slice(i + 1).toLowerCase();
    const hit = sorted.find((m) => {
      const n = m.name.toLowerCase();
      return rest.startsWith(n) && !WORD.test(text[i + 1 + n.length] ?? '');
    });
    if (!hit) {
      out += ch;
      i += 1;
      continue;
    }
    out += `@[${hit.name}](member:${hit.id})`;
    i += 1 + hit.name.length;
  }
  return out;
}
