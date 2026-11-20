/** A tiny external store for `useSyncExternalStore`: the editor's plugins write it, React components read it. */

import { useSyncExternalStore } from 'react';

/** A value with listeners. */
export class Store<T> {
  private value: T;
  private listeners = new Set<() => void>();

  /** @param initial - The first value. */
  constructor(initial: T) {
    this.value = initial;
  }

  /** The current value. */
  get = (): T => this.value;

  /**
   * Replaces the value and tells the listeners (nothing happens when it is the same object).
   * @param next - The new value, or a function of the current one.
   */
  set = (next: T | ((cur: T) => T)): void => {
    const v = typeof next === 'function' ? (next as (cur: T) => T)(this.value) : next;
    if (Object.is(v, this.value)) return;
    this.value = v;
    this.listeners.forEach((l) => l());
  };

  /**
   * Calls `l` after every change; returns the unsubscribe function.
   * @param l - The listener.
   */
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

/**
 * The value of a store, re-rendering on changes.
 * @param store - The store (a fallback value is read when it is missing).
 * @param fallback - The value without a store.
 */
export function useStore<T>(store: Store<T> | null | undefined, fallback: T): T {
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store ? store.get : () => fallback,
    store ? store.get : () => fallback,
  );
}

const noopSubscribe = () => () => undefined;
