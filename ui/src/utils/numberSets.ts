/** Lists of numbers kept in ascending order: warning thresholds, weekdays, picked rows. */

/** The numbers in ascending order. A plain `.sort()` compares them as text, which puts 100 before 50. */
export function ascending(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** `values` with `value` removed when it is there, otherwise added, in ascending order. */
export function toggleNumber(values: readonly number[], value: number): number[] {
  return values.includes(value) ? values.filter((x) => x !== value) : ascending([...values, value]);
}
