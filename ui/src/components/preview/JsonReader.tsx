import { useEffect, useMemo, useState } from 'react';
import { Notice, StatePanel } from './StatePanel';
import { AsyncBody, TEXT_LIMIT, TextBody } from './TextReader';
import { decodeText, looksLikeText, useFileData } from './useFileData';
import { formatFileSize } from '../../utils/fileIcons';
import type { ReaderProps } from './readerTypes';
import styles from './PreviewViewer.module.css';

type Mode = 'formatted' | 'tree' | 'raw';

function Node({ name, value, depth, open }: { name?: string; value: unknown; depth: number; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  useEffect(() => setExpanded(open), [open]);
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === 'object';
  const label = name !== undefined ? <span className={styles.jsonKey}>{name}: </span> : null;
  if (!isObj) {
    const cls =
      typeof value === 'string' ? styles.tokString : typeof value === 'number' ? styles.tokNumber : styles.tokKeyword;
    return (
      <div className={styles.jsonRow} style={{ paddingLeft: depth * 16 }}>
        {label}
        <span className={cls}>{JSON.stringify(value)}</span>
      </div>
    );
  }
  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as object);
  return (
    <div>
      <button
        type="button"
        className={styles.jsonToggle}
        style={{ paddingLeft: depth * 16 }}
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {label}
        <span className={styles.jsonMeta}>
          {isArr ? '[' : '{'} {entries.length}{' '}
          {isArr ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}{' '}
          {isArr ? ']' : '}'}
        </span>
      </button>
      {expanded && entries.map(([k, v]) => <Node key={k} name={k} value={v} depth={depth + 1} open={open} />)}
    </div>
  );
}

/** JSON reader: formatted, tree or raw. */
export function JsonReader({ item, onFacts, actions }: ReaderProps) {
  const [state, retry] = useFileData(item.src, TEXT_LIMIT);
  const [mode, setMode] = useState<Mode>('formatted');
  const [openAll, setOpenAll] = useState(false);
  const raw = useMemo(() => (state.status === 'ready' ? decodeText(state.bytes) : ''), [state]);
  const parsed = useMemo(() => {
    if (state.status !== 'ready' || state.truncated) return { ok: false as const };
    try {
      return { ok: true as const, value: JSON.parse(raw) as unknown };
    } catch {
      // JSON Lines: one value per line
      try {
        const rows = raw
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as unknown);
        return rows.length > 1 ? { ok: true as const, value: rows } : { ok: false as const };
      } catch {
        return { ok: false as const };
      }
    }
  }, [state, raw]);
  const formatted = useMemo(() => (parsed.ok ? JSON.stringify(parsed.value, null, 2) : raw), [parsed, raw]);

  useEffect(() => {
    if (state.status === 'ready') onFacts({ Valid: parsed.ok ? 'Valid JSON' : 'Not valid JSON' });
  }, [state, parsed, onFacts]);

  const binary = state.status === 'ready' && !looksLikeText(state.bytes);

  const modes: { id: Mode; label: string }[] = [
    { id: 'formatted', label: 'Formatted' },
    { id: 'tree', label: 'Tree' },
    { id: 'raw', label: 'Raw' },
  ];
  const switcher = (
    <div className={styles.readerBar}>
      <div className={styles.segmented} role="tablist" aria-label="JSON view">
        {modes.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <span className={styles.readerLabel}>
        {item.name} · {parsed.ok ? 'valid JSON' : state.status === 'ready' ? 'not valid JSON' : '…'}
      </span>
      <span className={styles.readerBarSpacer} />
      {mode === 'tree' && (
        <button type="button" onClick={() => setOpenAll((v) => !v)}>
          {openAll ? 'Collapse all' : 'Expand all'}
        </button>
      )}
    </div>
  );

  return (
    <AsyncBody state={state} retry={retry} actions={actions} name={item.name}>
      {state.status === 'ready' &&
        (binary ? (
          <StatePanel tone="warn" title="Not readable as text" actions={actions}>
            This file has a .json name but contains binary data. Showing the file facts instead.
          </StatePanel>
        ) : (
          <div className={styles.jsonReader}>
            {switcher}
            {state.truncated && (
              <Notice actions={actions}>
                Showing the first {formatFileSize(TEXT_LIMIT)}. Large files are shown as raw text only.
              </Notice>
            )}
            {mode === 'tree' && parsed.ok ? (
              <div className={styles.jsonTree}>
                <Node value={parsed.value} depth={0} open={openAll} />
              </div>
            ) : (
              <TextBody
                text={mode === 'raw' ? raw : formatted}
                lang="JSON"
                label={mode === 'raw' ? 'Raw' : 'Formatted'}
              />
            )}
          </div>
        ))}
    </AsyncBody>
  );
}
