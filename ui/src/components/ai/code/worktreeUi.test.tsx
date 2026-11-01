import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Worktree } from '../../../types/aiCode';
import type { AiRun } from '../../../types/ai';
import { ConflictCard, STATE_LABEL, WorktreeRow, canRemove, mbText } from './worktreeUi';

const wt = (over: Partial<Worktree> = {}, uncommitted: string[] = []): Worktree => ({
  ticketId: 'KAN-1',
  projectId: 'p',
  repo: '/r',
  path: '/r.worktrees/KAN-1',
  branch: 'ai/KAN-1-x',
  base: 'main',
  port: 5181,
  state: 'active',
  handover: null,
  prUrl: null,
  prNumber: null,
  conflictFiles: [],
  preparedAt: null,
  prepareS: null,
  createdAt: '',
  lastUsedAt: null,
  mergedAt: null,
  live: { uncommitted, sizeMb: 420, exists: true, ahead: 1 },
  ...over,
});
const run = (state: string) =>
  ({ id: 'r1', ticketId: 'KAN-1', memberName: 'Dev An', state, endedAt: '2026-01-01T10:31:00' }) as unknown as AiRun;
const row = (w: Worktree, r?: AiRun) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <WorktreeRow
          w={w}
          run={r}
          onRemove={() => {}}
          onKeep={() => {}}
          onCopyPath={() => {}}
          onOpen={() => {}}
          onStop={() => {}}
        />
      </tbody>
    </table>,
  );

describe('worktree list', () => {
  it('names each state in the words of the design', () => {
    expect(STATE_LABEL.active).toBe('In use');
    expect(STATE_LABEL.conflict).toBe('Conflict with main');
    expect(STATE_LABEL.merged).toBe('Merged');
  });

  it('sizes in MB then GB', () => {
    expect(mbText(420)).toBe('420 MB');
    expect(mbText(1946)).toBe('1.9 GB');
  });

  it('never offers Remove while something is uncommitted; offers Keep', () => {
    const w = wt({}, ['a.ts', 'b.ts']);
    expect(canRemove(w)).toBe(false);
    const html = row(w);
    expect(html).not.toContain('>Remove<');
    expect(html).toContain('>Keep<');
    expect(html).toContain('2 files changed, not committed');
  });

  it('offers Remove when clean, and Resolve on a conflict', () => {
    expect(row(wt())).toContain('>Remove<');
    const html = row(wt({ state: 'conflict' }));
    expect(html).toContain('>Resolve<');
    expect(html).toContain('Conflict with main');
  });
});

describe('worktree row, run and folder', () => {
  it('offers Open folder, and Stop while a run is going', () => {
    const html = row(wt({}, ['a.ts']), run('running'));
    expect(html).toContain('>Open folder<');
    expect(html).toContain('>Stop<');
    expect(html).toContain('Dev An · 1 file changed, not committed');
    expect(html).toContain('In use');
  });

  it('says Waiting for you when the AI stopped with changes that are not committed', () => {
    const html = row(wt({}, ['a.ts', 'b.ts']), run('finished'));
    expect(html).toContain('Waiting for you');
    expect(html).toContain('Dev An stopped at');
    expect(html).not.toContain('>Stop<');
  });
});

describe('ConflictCard', () => {
  it('lists the files and the three choices, naming the member', () => {
    const html = renderToStaticMarkup(
      <ConflictCard files={['a.py', 'b.ts']} memberName="Dev An" onChoose={() => {}} />,
    );
    expect(html).toContain('2 files differ from main: a.py, b.ts');
    expect(html).toContain('Give it to Dev An');
    expect(html).toContain('I will do it');
    expect(html).toContain('Leave it for now');
  });

  it('offers no AI hand-over when nobody is named', () => {
    const html = renderToStaticMarkup(<ConflictCard files={[]} memberName={null} onChoose={() => {}} />);
    expect(html).not.toContain('Give it to');
    expect(html).toContain('I will do it');
  });
});
