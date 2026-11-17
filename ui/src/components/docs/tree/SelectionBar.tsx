/**
 * Selecting several pages (design "Rich Docs — organising pages", C 24-26): the bar at the bottom of the tree that
 * names how many pages will change (a parent brings its child pages), with Move, Duplicate, Export as a book and
 * Delete, and the confirmation Delete asks for first.
 */

import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsTreeNode } from '../../../types/docs';
import { BottomSheet } from '../DocsSheets';
import { ModalShell, plural, Spacer } from '../docsShared';
import { Icon } from '../Icon';
import './tree.css';

/**
 * The selection bar.
 * @param props.selected - How many pages were picked.
 * @param props.affected - How many pages the actions change (the picked ones and every page under them).
 * @param props.readOnly - The reader can't edit: only Export is offered.
 */
export function SelectionBar({
  selected,
  affected,
  readOnly,
  onMove,
  onDuplicate,
  onExport,
  onDelete,
  onSelectAll,
  onDone,
}: {
  selected: number;
  affected: number;
  readOnly?: boolean;
  onMove: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onSelectAll: () => void;
  onDone: () => void;
}) {
  const none = selected === 0;
  return (
    <div className="tr-selbar" role="toolbar" aria-label="Selected pages" data-testid="tree-selection-bar">
      <div className="tr-selbar-top">
        <span className="tr-selbar-count" role="status">
          {none ? 'Select pages' : `${selected} selected · ${plural(affected, 'page')}`}
        </span>
        <button type="button" className="tr-link" onClick={onSelectAll}>
          Select all
        </button>
        <button type="button" className="tr-link" onClick={onDone} data-testid="tree-selection-done">
          Done
        </button>
      </div>
      <div className="tr-selbar-actions">
        {!readOnly && (
          <button type="button" className="tr-selbtn" disabled={none} onClick={onMove} data-testid="bulk-move">
            <Icon name="i35" size={17} strokeWidth={1.9} />
            Move
          </button>
        )}
        {!readOnly && (
          <button
            type="button"
            className="tr-selbtn"
            disabled={none}
            onClick={onDuplicate}
            data-testid="bulk-duplicate"
          >
            <Icon name="i24" size={17} strokeWidth={1.9} />
            Duplicate
          </button>
        )}
        <button
          type="button"
          className="tr-selbtn"
          disabled={none}
          onClick={onExport}
          title="Export as a book"
          data-testid="bulk-export"
        >
          <Icon name="i43" size={17} strokeWidth={1.9} />
          Export
        </button>
        {!readOnly && (
          <button
            type="button"
            className="tr-selbtn tr-selbtn-danger"
            disabled={none}
            onClick={onDelete}
            data-testid="bulk-delete"
          >
            <Icon name="i12" size={17} strokeWidth={1.9} />
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "Delete N pages?": names the picked pages, how many go with them, and how long they can be restored.
 * @param props.roots - The picked pages none of whose parents is picked (what is deleted).
 * @param props.affected - Every page that goes to the Recycle Bin.
 */
export function BulkDeleteDialog({
  roots,
  affected,
  layout,
  onConfirm,
  onClose,
}: {
  roots: DocsTreeNode[];
  affected: number;
  layout: DocsLayout;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const title = `Delete ${plural(roots.length, 'page')}?`;
  const text = (
    <>
      <ul className="tr-del-list">
        {roots.slice(0, 6).map((r) => (
          <li key={r.id}>{r.title}</li>
        ))}
        {roots.length > 6 && <li>and {roots.length - 6} more</li>}
      </ul>
      <p className="tr-del-text">
        {affected > roots.length
          ? `With their child pages, ${plural(affected, 'page')} move to the Recycle Bin.`
          : `${plural(affected, 'page')} move to the Recycle Bin.`}{' '}
        Links to them show “In Recycle Bin” until they are restored; nothing in other pages is rewritten.
      </p>
      <p className="tr-del-text">
        Kept in the Recycle Bin for 30 days, then deleted forever. Restoring brings back the whole tree.
      </p>
    </>
  );
  const confirm = (
    <button type="button" className="st-btn st-btn-danger" data-testid="bulk-delete-confirm" onClick={onConfirm}>
      Delete {plural(affected, 'page')}
    </button>
  );
  if (layout === 'phone')
    return (
      <BottomSheet label={title} onClose={onClose} testId="bulk-delete-sheet">
        <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {confirm}
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          {text}
        </div>
      </BottomSheet>
    );
  return (
    <ModalShell
      width={500}
      ariaLabel={title}
      icon="i12"
      iconTone="red"
      title={title}
      onClose={onClose}
      bodyStyle={{ padding: '14px 22px', display: 'flex', flexDirection: 'column', gap: 8 }}
      footer={
        <>
          <Spacer />
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          {confirm}
        </>
      }
    >
      {text}
    </ModalShell>
  );
}
