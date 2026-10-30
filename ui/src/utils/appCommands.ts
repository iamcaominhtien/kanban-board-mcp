import { useEffect, useRef } from 'react';

/** A command from the desktop menu (or anything else) that a screen can answer, for example `new-project`. */
export interface AppCommand {
  command: string;
  [key: string]: unknown;
}

const EVENT = 'kanban:app-command';

/** Sends a command to whichever screen listens for it. Nothing happens when no screen does. */
export function emitAppCommand(cmd: AppCommand): void {
  window.dispatchEvent(new CustomEvent<AppCommand>(EVENT, { detail: cmd }));
}

/**
 * Runs `handler` whenever the command `name` is sent. The latest handler is always used, so it needs no memo.
 * @param name - The command, for example `find-board`.
 * @param handler - What this screen does with it.
 */
export function useAppCommand(name: string, handler: (cmd: AppCommand) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const on = (e: Event) => {
      const cmd = (e as CustomEvent<AppCommand>).detail;
      if (cmd && cmd.command === name) ref.current(cmd);
    };
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [name]);
}
