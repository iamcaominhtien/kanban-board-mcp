import type { DatabaseInfo, MoveJob, TestReport } from '../../../api/database';

/** Test fixtures for the Database card and the move wizard (already camel-cased, as the client hands them over). */

/** GET /database on SQLite. */
export function sqliteDb(over: Partial<DatabaseInfo> = {}): DatabaseInfo {
  return {
    engine: 'sqlite',
    label: 'SQLite',
    display: '/Users/minh/kanban-data/kanban.db',
    settings: { engine: 'sqlite', path: '/Users/minh/kanban-data/kanban.db' },
    source: 'default',
    locked: false,
    envVar: 'KANBAN_DATABASE_URL',
    passwordStore: 'keychain',
    passwordSaved: false,
    dataFolder: '/Users/minh/kanban-data',
    sqliteFile: { path: '/Users/minh/kanban-data/kanban.db', exists: true, size: 50_331_648, modified: 1_700_000_000 },
    reachable: true,
    latencyMs: 1,
    tickets: 1204,
    projects: 3,
    aiMembers: 7,
    tables: 87,
    size: 50_331_648,
    version: 'SQLite 3.45.1',
    unreachable: null,
    move: null,
    ...over,
  };
}

/** GET /database on PostgreSQL. */
export function postgresDb(over: Partial<DatabaseInfo> = {}): DatabaseInfo {
  return sqliteDb({
    engine: 'postgresql',
    label: 'PostgreSQL',
    display: 'kanban@db.internal:5432/kanban',
    settings: { engine: 'postgresql', host: 'db.internal', port: 5432, name: 'kanban', user: 'kanban', ssl: 'require' },
    source: 'settings',
    passwordSaved: true,
    latencyMs: 12,
    size: null,
    version: 'PostgreSQL 16.2',
    secure: true,
    otherApps: 0,
    ...over,
  });
}

/** A passing test report. */
export function okReport(over: Partial<TestReport> = {}): TestReport {
  return {
    target: { engine: 'postgresql', host: 'db.internal', port: 5432, name: 'kanban', user: 'kanban', ssl: 'prefer' },
    findings: [
      {
        key: 'reach',
        level: 'ok',
        title: 'Reached the server · db.internal:5432 · 12 ms',
        detail: '',
        fix: '',
        fixLabel: '',
      },
      { key: 'empty', level: 'ok', title: 'Database is empty · 0 tables', detail: '', fix: '', fixLabel: '' },
    ],
    reached: true,
    version: 'PostgreSQL 16.2',
    latencyMs: 12,
    state: 'empty',
    tables: 0,
    revision: null,
    tickets: null,
    secure: false,
    otherApps: 0,
    ok: true,
    ...over,
  };
}

/** A move job (state "ready" with a plan unless told otherwise). */
export function job(over: Partial<MoveJob> = {}): MoveJob {
  return {
    id: 'm1',
    state: 'ready',
    mode: null,
    source: {
      engine: 'sqlite',
      path: '/Users/minh/kanban-data/kanban.db',
      label: 'SQLite',
      display: '/Users/minh/kanban-data/kanban.db',
    },
    target: {
      engine: 'postgresql',
      host: 'db.internal',
      port: 5432,
      name: 'kanban',
      user: 'kanban',
      ssl: 'prefer',
      label: 'PostgreSQL',
      display: 'kanban@db.internal:5432/kanban',
    },
    plan: {
      source: {
        engine: 'sqlite',
        label: 'SQLite',
        display: '/Users/minh/kanban-data/kanban.db',
        size: 50_331_648,
        tables: 87,
        rows: 61_000,
        tickets: 1204,
        projects: 3,
        aiMembers: 7,
        atHead: true,
      },
      target: { engine: 'postgresql', label: 'PostgreSQL', display: 'kanban@db.internal:5432/kanban' },
      tables: [],
      rows: 61_000,
      extraTables: [],
      notes: [{ key: 'search', title: 'Docs search is rebuilt', detail: 'after the copy' }],
      problems: [],
      tablesCount: 87,
    },
    report: okReport(),
    tables: [],
    tablesDone: 0,
    tablesTotal: 87,
    rowsTotal: 61_000,
    rowsDone: 0,
    current: null,
    elapsedS: null,
    leftS: null,
    stop: null,
    verify: null,
    error: null,
    ai: { state: 'idle' },
    resumeAt: null,
    applied: [],
    ...over,
  };
}

/** A copy that stopped in idea_ticket (D4). */
export function stoppedJob(over: Partial<MoveJob> = {}): MoveJob {
  return job({
    state: 'stopped',
    mode: 'copy',
    target: {
      engine: 'mysql',
      host: 'mysql.internal',
      port: 3306,
      name: 'kanban',
      user: 'kanban_app',
      ssl: 'prefer',
      label: 'MySQL / MariaDB',
      display: 'kanban_app@mysql.internal:3306/kanban',
    },
    tables: [
      { name: 'project', rows: 3, copied: 3, state: 'done' },
      { name: 'idea_ticket', rows: 340, copied: 212, state: 'stopped' },
    ],
    tablesDone: 31,
    current: 'idea_ticket',
    resumeAt: 'idea_ticket',
    stop: {
      table: 'idea_ticket',
      row: 213,
      copied: 212,
      total: 340,
      tablesDone: 31,
      tablesTotal: 87,
      error: "Data too long for column 'body' at row 213",
      code: '1406',
      column: 'body',
      valueLength: 6412,
      valueNull: false,
      sourceType: 'VARCHAR',
      targetType: 'VARCHAR(255)',
      sourceEngine: 'SQLite',
      targetEngine: 'mysql',
      targetVersion: 'MariaDB 10.11',
    },
    ...over,
  });
}
