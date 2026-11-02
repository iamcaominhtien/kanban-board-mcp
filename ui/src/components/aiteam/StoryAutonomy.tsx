import { useMemo, useState } from 'react';
import type { HealthStory } from '../../api/aiTeam';
import { useStories } from '../../api/stories';
import type { StoryView } from '../../types/story';
import { Ico, StoryStateChip, storyFace, type StoryFace } from '../story/storyUi';
import './decided.css';
import './away.css';

const MARK = {
  needed: { bg: '#FEF3D9', fg: '#7A5A06', label: 'Needed' },
  avoidable: { bg: '#FDECE8', fg: '#A5321E', label: 'Avoidable' },
  byRule: { bg: '#E8F1FA', fg: '#244E78', label: 'By rule' },
} as const;

/** The order and the words of the Stories tile ("1 blocked · 1 running · 1 review · 1 planning · 1 done"). */
const FACE_WORD: [StoryFace[], string][] = [
  [['blocked'], 'blocked'],
  [['in_progress'], 'running'],
  [['review'], 'review'],
  [['planning', 'plan_needs_you'], 'planning'],
  [['draft'], 'draft'],
  [['done'], 'done'],
  [['dropped'], 'dropped'],
];

function faceOf(s: HealthStory, views: Map<string, StoryView>): StoryFace {
  const v = views.get(s.id);
  if (v) return storyFace(v);
  return (s.state as StoryFace | null) ?? 'in_progress';
}

/** "Needed: You answered … on KAN-289" → the mark and the text. */
function splitReason(r: string): { mark: keyof typeof MARK | null; text: string } {
  const m = /^(Needed|Avoidable):\s*/.exec(r);
  if (!m) return { mark: null, text: r };
  return { mark: m[1] === 'Needed' ? 'needed' : 'avoidable', text: r.slice(m[0].length) };
}

function MarkChip({ mark, n }: { mark: keyof typeof MARK; n?: number }) {
  const k = MARK[mark];
  return (
    <span className="at-chip" style={{ background: k.bg, color: k.fg }}>
      {k.label}
      {n != null ? ` ${n}` : ''}
    </span>
  );
}

function why(s: HealthStory, face: StoryFace): string {
  const first = s.reasons[0];
  if (first) {
    const more = s.reasons.length - 1;
    return `${first}${more > 0 ? ` (and ${more} more)` : ''}`;
  }
  if (s.touches.byRule) return 'The only touches are the ones your project asks for.';
  if (face === 'done') return 'Done without anyone stepping in.';
  if (face === 'planning' || face === 'plan_needs_you' || face === 'draft') return 'Plan not under way yet.';
  return 'Nobody had to step in.';
}

/**
 * Autonomy by Story on the Health tab (design/screens/ai-story-flow.md, R3): how many times a person had to step in
 * on each Story, with the reasons. A step the project asks for is By rule and not counted against the Story.
 */
export function StoryAutonomy({
  projectId,
  stories,
  onOpenStepped,
  onOpenStory,
}: {
  projectId: string;
  stories: HealthStory[];
  onOpenStepped: () => void;
  onOpenStory: (storyId: string) => void;
}) {
  const list = useStories(projectId);
  const views = useMemo(() => new Map((list.data ?? []).map((s) => [s.id, s])), [list.data]);
  const [open, setOpen] = useState<string | null>(null);
  const counted = (s: HealthStory) => s.touches.needed + s.touches.avoidable;
  const needed = stories.reduce((n, s) => n + s.touches.needed, 0);
  const avoidable = stories.reduce((n, s) => n + s.touches.avoidable, 0);
  const byRule = stories.reduce((n, s) => n + s.touches.byRule, 0);
  const clean = stories.filter((s) => counted(s) === 0).length;
  const faces = stories.map((s) => faceOf(s, views));
  const stateWords = FACE_WORD.map(([fs, word]) => {
    const n = faces.filter((f) => fs.includes(f)).length;
    return n ? `${n} ${word}` : null;
  }).filter(Boolean);

  return (
    <>
      <div className="at-tiles" data-testid="story-autonomy-tiles">
        <div className="at-tile">
          <div className="at-label">Stories</div>
          <span className="at-total-n">{stories.length}</span>
          <div className="at-hint-sm">{stateWords.length ? stateWords.join(' · ') : 'no Story in this range'}</div>
        </div>
        <div className="at-tile">
          <div className="at-label">Stepped in on Stories</div>
          <span className="at-total-n" style={{ color: needed + avoidable ? '#7A5A06' : '#1F5A31' }}>
            {needed + avoidable}
          </span>
          <div className="at-hint-sm">
            needed {needed} · avoidable {avoidable}. By rule {byRule} {byRule === 1 ? 'is' : 'are'} not counted
          </div>
        </div>
        <div className="at-tile">
          <div className="at-label">Stories with 0</div>
          <span className="at-total-n" style={{ color: '#1F5A31' }}>
            {clean} of {stories.length}
          </span>
          <div className="at-hint-sm">the goal for a Story is 0</div>
        </div>
      </div>

      <div className="as-head">
        <b style={{ fontSize: 14, whiteSpace: 'nowrap' }}>Autonomy by Story</b>
        <span className="as-new">NEW</span>
        <span className="at-hint" style={{ flex: 1, minWidth: 260 }}>
          How many times a person had to step in on each Story. A step the project asks for (an approval, Done) is shown
          as <i>By rule</i> and is not counted against the Story.
        </span>
        <button type="button" className="st-btn st-btn-sm" onClick={onOpenStepped} data-testid="open-stepped">
          <Ico name="open" size={13} />
          Open in You stepped in
        </button>
      </div>

      <div className="dy-table" data-testid="story-autonomy">
        <div className="as-row head at-label">
          <span>Story</span>
          <span>Tickets</span>
          <span>You stepped in</span>
          <span>Why</span>
          <span />
        </div>
        {stories.length === 0 && (
          <div className="at-hint" style={{ padding: 16 }}>
            No Story had work or a touch in this range.
          </div>
        )}
        {stories.map((s, i) => {
          const face = faces[i];
          const n = counted(s);
          const isOpen = open === s.id;
          const canOpen = s.reasons.length > 0;
          return (
            <div key={s.id}>
              <div
                className={`as-row${canOpen ? ' click' : ''}${isOpen ? ' open' : ''}`}
                onClick={() => canOpen && setOpen(isOpen ? null : s.id)}
                aria-expanded={canOpen ? isOpen : undefined}
                data-testid="story-autonomy-row"
              >
                <div style={{ display: 'flex', gap: 9, alignItems: 'center', minWidth: 0 }}>
                  <span className="as-story-ico">
                    <Ico name="story" size={12} color="#1B3A6B" />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <button
                      type="button"
                      className="aw-link-title"
                      style={{ display: 'block', maxWidth: '100%', fontSize: 13, fontWeight: 700 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenStory(s.id);
                      }}
                    >
                      {s.title}
                    </button>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span className="aw-mono">{s.id}</span>
                      <StoryStateChip face={face} />
                    </div>
                  </div>
                </div>
                <span style={{ fontSize: 12.5 }}>
                  {s.ticketsDone} of {s.ticketsTotal} done
                </span>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <b
                    style={{
                      fontSize: 22,
                      color: s.touches.avoidable ? '#A5321E' : s.touches.needed ? '#7A5A06' : '#2E6F40',
                    }}
                  >
                    {n}
                  </b>
                  <span className="at-hint-sm">goal 0</span>
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    {s.touches.needed > 0 && <MarkChip mark="needed" n={s.touches.needed} />}
                    {s.touches.avoidable > 0 && <MarkChip mark="avoidable" n={s.touches.avoidable} />}
                    {s.touches.byRule > 0 && <MarkChip mark="byRule" n={s.touches.byRule} />}
                    {!n && !s.touches.byRule && <span className="at-hint">No one stepped in</span>}
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.4, color: '#3A4A3E' }}>{why(s, face)}</div>
                </div>
                <span style={{ color: '#9AA8A0' }}>
                  {canOpen && <Ico name={isOpen ? 'up' : 'down'} size={14} color="#9AA8A0" />}
                </span>
              </div>
              {isOpen && (
                <div className="as-reasons" data-testid="story-autonomy-reasons">
                  {s.reasons.map((r, j) => {
                    const { mark, text } = splitReason(r);
                    return (
                      <div key={j} className="as-reason">
                        <span>{text}</span>
                        <span>{mark && <MarkChip mark={mark} />}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
