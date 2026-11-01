/** Sorting that does not trip on `.sort()` without a compare: numbers compared as numbers, text by locale. */

/** The numbers in ascending order. A plain `.sort()` compares them as text, which puts 100 before 50. */
export function ascending(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** The strings in locale order (tags, zones, ids joined into a key). */
export function ascendingText(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

/** The strings in character-code order: the order Python's `sorted()` gives, for keys the server builds too. */
export function ascendingCodeUnits(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** `values` with `value` removed when it is there, otherwise added, in ascending order. */
export function toggleNumber(values: readonly number[], value: number): number[] {
  return values.includes(value) ? values.filter((x) => x !== value) : ascending([...values, value]);
}
