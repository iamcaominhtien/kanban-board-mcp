import { describe, expect, it, vi } from 'vitest';
import {
  clearDatabaseUnreachable,
  databaseUnreachableNow,
  reportDatabaseUnreachable,
  subscribeDatabaseUnreachable,
  unreachableOf,
} from './databaseDown';

describe('databaseDown', () => {
  it('reads a 503 database_unreachable answer, and nothing else', () => {
    const err = {
      response: {
        status: 503,
        data: {
          detail: { code: 'database_unreachable', since: 100, error: 'timeout', target: { host: 'db', port: 5432 } },
        },
      },
    };
    expect(unreachableOf(err)).toEqual({ since: 100, error: 'timeout', target: { host: 'db', port: 5432 } });
    expect(unreachableOf({ response: { status: 503, data: { detail: 'busy' } } })).toBeNull();
    expect(unreachableOf({ response: { status: 500, data: { detail: { code: 'database_unreachable' } } } })).toBeNull();
    expect(unreachableOf(new Error('x'))).toBeNull();
  });

  it('tells its listeners when the database goes and comes back', () => {
    const fn = vi.fn();
    const stop = subscribeDatabaseUnreachable(fn);
    const down = { since: 1, error: 'e', target: {} };
    reportDatabaseUnreachable(down);
    expect(databaseUnreachableNow()).toBe(down);
    clearDatabaseUnreachable();
    expect(databaseUnreachableNow()).toBeNull();
    expect(fn.mock.calls).toEqual([[down], [null]]);
    stop();
    reportDatabaseUnreachable(down);
    expect(fn).toHaveBeenCalledTimes(2);
    clearDatabaseUnreachable();
  });
});
