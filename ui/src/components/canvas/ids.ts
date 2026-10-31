/** A new id for a note, arrow, label or page tab: a letter and 8 hex digits, the form the server keeps. */
export function newId(prefix: 'n' | 'a' | 't' | 'p'): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
