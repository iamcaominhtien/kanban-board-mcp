/** One undoable change. */
export interface Step {
  /** Short name, for the Undo tooltip. */
  label: string;
  /** Memory the step holds, in bytes. */
  bytes: number;
  undo(): void;
  redo(): void;
}

/** At least this many steps are always kept, whatever the memory they use. */
export const MIN_STEPS = 100;
const MAX_STEPS = 250;
const MAX_BYTES = 512 * 1024 * 1024;

/**
 * The undo and redo stacks. One history serves the whole drawing, so undo goes back through changes
 * made with different tools and on different layers, in the order they were made.
 */
export class History {
  private steps: Step[] = [];
  private cursor = 0; // steps[0..cursor) are done, the rest can be redone
  private maxSteps: number;
  private maxBytes: number;
  private listener: (() => void) | null = null;

  /**
   * @param maxSteps - Most steps to keep (never fewer than 100 are dropped for memory).
   * @param maxBytes - Memory budget; the oldest steps go first once it is passed, down to 100 steps.
   */
  constructor(maxSteps = MAX_STEPS, maxBytes = MAX_BYTES) {
    this.maxSteps = Math.max(maxSteps, MIN_STEPS);
    this.maxBytes = maxBytes;
  }

  /**
   * Call `fn` after every change of the stacks.
   * @param fn - Listener, or null to remove it.
   */
  onChange(fn: (() => void) | null): void {
    this.listener = fn;
  }

  /**
   * Record a change that has just been made. Whatever could have been redone is forgotten.
   * @param step - The change.
   */
  push(step: Step): void {
    this.steps.length = this.cursor;
    this.steps.push(step);
    this.cursor = this.steps.length;
    let bytes = this.steps.reduce((n, s) => n + s.bytes, 0);
    while (this.steps.length > this.maxSteps || (bytes > this.maxBytes && this.steps.length > MIN_STEPS)) {
      bytes -= (this.steps.shift() as Step).bytes;
      this.cursor--;
    }
    this.listener?.();
  }

  /** Undo the latest change; returns it, or null when there is nothing to undo. */
  undo(): Step | null {
    if (this.cursor === 0) return null;
    const step = this.steps[--this.cursor];
    step.undo();
    this.listener?.();
    return step;
  }

  /** Redo the change undone last; returns it, or null when there is nothing to redo. */
  redo(): Step | null {
    if (this.cursor >= this.steps.length) return null;
    const step = this.steps[this.cursor++];
    step.redo();
    this.listener?.();
    return step;
  }

  /** Whether there is a change to undo. */
  get canUndo(): boolean {
    return this.cursor > 0;
  }

  /** Whether there is a change to redo. */
  get canRedo(): boolean {
    return this.cursor < this.steps.length;
  }

  /** Number of changes that can be undone. */
  get depth(): number {
    return this.cursor;
  }

  /** Label of the change an undo would take back. */
  get undoLabel(): string | null {
    return this.cursor > 0 ? this.steps[this.cursor - 1].label : null;
  }

  /** Forget everything. */
  clear(): void {
    this.steps = [];
    this.cursor = 0;
    this.listener?.();
  }
}
