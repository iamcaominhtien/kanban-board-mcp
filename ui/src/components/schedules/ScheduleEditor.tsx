import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAiTeams } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useMembers } from '../../api/members';
import { scheduleApi, useScheduleDetail, useScheduleMutation } from '../../api/schedules';
import type { Member, Ticket } from '../../types';
import type { AiTeam } from '../../types/ai';
import type { DryRun, Schedule, ScheduleDraft, ScheduleErrorBody, ScheduleNotify } from '../../types/schedules';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../Toast';
import { currentPerson } from '../assist/assistUi';
import { CheckLine, MemberSelect, TicketPicker, ZoneSelect } from './MemberSelect';
import { MenuSelect } from '../ui/MenuSelect';
import { SCHEDULE_TEMPLATES } from './scheduleTemplates';
import {
  CalendarIcon,
  CheckCircleIcon,
  ClockIcon,
  CloseIcon,
  DAY_NAMES,
  FlaskIcon,
  PROVIDER_NAME,
  TimeField,
  canStart,
  zoneLabel,
} from './schedulesUi';
import { ascendingText, toggleNumber } from '../../utils/sorted';
import { LineIcon } from '../ui/LineIcon';

/** How the editor is opened: from the tab, from a ticket (locked to it) or to change a schedule. */
export interface EditorOpts {
  scheduleId?: string;
  ticketId?: string;
  memberId?: string;
}

const NOTIFY_OPTIONS: { key: ScheduleNotify; label: string }[] = [
  { key: 'started', label: 'Started' },
  { key: 'needs_input', label: 'Needs input' },
  { key: 'failed', label: 'Failed or skipped' },
  { key: 'finished', label: 'Finished' },
];

const STOP_AFTER = [15, 30, 45, 60, 90, 120, 180, 240, 360, 600];
const CATCH_UP_HOURS = [0.5, 1, 2, 3, 4, 6, 12, 24];

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-30T02:00": tomorrow at 02:00, the default for a one-time run. */
function tomorrowAt(time = '02:00'): string {
  const d = new Date(Date.now() + 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${time}`;
}

/** Old names some browsers still report, and the zone the server knows them by. */
const ZONE_ALIASES: Record<string, string> = {
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Dacca': 'Asia/Dhaka',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Asia/Macao': 'Asia/Macau',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Europe/Kiev': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Truk': 'Pacific/Chuuk',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
};

/** The browser's time zone, "UTC" when it cannot tell. */
function browserZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    return ZONE_ALIASES[tz] ?? tz;
  } catch {
    return 'UTC';
  }
}

/** Starting values of a new schedule. */
function newDraft(ticketId: string, memberId: string): ScheduleDraft {
  return {
    ticketId,
    memberId,
    backupMemberId: '',
    kind: 'repeat',
    runAt: tomorrowAt(),
    days: [0, 1, 2, 3, 4],
    time: '02:00',
    tz: browserZone(),
    ends: 'never',
    endsAfter: null,
    endsOn: '',
    windowEnd: '',
    limits: { stopAfterMin: 45, retries: 1, maxCost: null },
    catchUp: 'run',
    catchUpHours: 2,
    notify: ['started', 'needs_input', 'failed', 'finished'],
    notifyPeople: [],
    instruction: '',
  };
}

/** The editor's values of a saved schedule. */
function draftOf(s: Schedule): ScheduleDraft {
  return {
    ticketId: s.ticketId,
    memberId: s.memberId,
    backupMemberId: s.backupMemberId ?? '',
    kind: s.kind,
    runAt: (s.runAt ?? tomorrowAt()).slice(0, 16),
    days: s.days,
    time: s.time,
    tz: s.tz,
    ends: s.ends,
    endsAfter: s.endsAfter,
    endsOn: s.endsOn ?? '',
    windowEnd: s.windowEnd ?? '',
    limits: s.limits,
    catchUp: s.catchUp,
    catchUpHours: s.catchUpHours,
    notify: s.notify,
    notifyPeople: s.notifyPeople,
    instruction: s.instruction ?? '',
  };
}

/** Time zones for the select, the schedule's own included. */
function useZones(current: string): { id: string; label: string }[] {
  return useMemo(() => {
    const api = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const ids = new Set<string>(api ? api('timeZone') : []);
    ids.add('UTC');
    ids.add(current);
    ids.add(browserZone());
    return ascendingText(ids).map((id) => ({ id, label: `${id} · ${zoneLabel(id)}` }));
  }, [current]);
}

function Section({ title, sub, children, id }: { title: string; sub: string; children: ReactNode; id?: string }) {
  return (
    <section className="sc-sec" data-testid={id}>
      <div className="sc-sec-h">
        <b>{title}</b>
        <div className="ai-muted">{sub}</div>
      </div>
      <div className="sc-sec-b">{children}</div>
    </section>
  );
}

function Field({ label, children, grow }: { label: string; children: ReactNode; grow?: boolean }) {
  return (
    <div className="ai-field" style={grow ? { flex: 1 } : undefined}>
      <span className="ai-label">{label}</span>
      {children}
    </div>
  );
}

function Seg<T extends string>({
  value,
  options,
  onChange,
  testId,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  testId?: string;
}) {
  return (
    <div className="sc-seg" role="tablist" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={value === o.id}
          className={value === o.id ? 'sc-seg-on' : ''}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Create or edit a schedule as a layer (C). The right side always shows the plain-language summary, the next
 * runs and the checks from the server (debounced), and "Dry run" shows what the lead would plan.
 */
export function ScheduleEditor({
  projectId,
  tickets,
  opts,
  onClose,
}: {
  projectId: string;
  tickets: Ticket[];
  opts: EditorOpts;
  onClose: () => void;
}) {
  const existing = useScheduleDetail(opts.scheduleId ?? null);
  const overview = useAiTeams(projectId);
  const { data: members = [] } = useMembers(projectId);
  if (opts.scheduleId && !existing.data) {
    return (
      <div className="ai-overlay" style={{ zIndex: 1000 }}>
        <div
          className="sc-editor ai-modal ai-root"
          style={{ alignItems: 'center', justifyContent: 'center', height: 200 }}
        >
          <span className="ai-spin" />
        </div>
      </div>
    );
  }
  const ais = (overview.data ?? []).filter(canStart);
  return (
    <EditorForm
      key={opts.scheduleId ?? 'new'}
      projectId={projectId}
      tickets={tickets}
      ais={ais}
      people={members.filter((m) => (m.kind ?? 'human') === 'human')}
      opts={opts}
      saved={existing.data}
      onClose={onClose}
    />
  );
}

function EditorForm({
  projectId,
  tickets,
  ais,
  people,
  opts,
  saved,
  onClose,
}: {
  projectId: string;
  tickets: Ticket[];
  ais: AiTeam[];
  people: Member[];
  opts: EditorOpts;
  saved?: Schedule;
  onClose: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState<ScheduleDraft>(() =>
    saved ? draftOf(saved) : newDraft(opts.ticketId ?? '', opts.memberId ?? ais[0]?.id ?? ''),
  );
  const [problems, setProblems] = useState<string[]>([]);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [dryError, setDryError] = useState<string | null>(null);
  const set = (patch: Partial<ScheduleDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const zones = useZones(draft.tz);
  const me = currentPerson();

  // Pick the first team once the list loads, when none was given
  useEffect(() => {
    if (!saved && !draft.memberId && ais[0]) setDraft((d) => (d.memberId ? d : { ...d, memberId: ais[0].id }));
  }, [saved, draft.memberId, ais]);

  // Preview: the server's summary, next runs and checks, 300 ms after the last change
  const [debounced, setDebounced] = useState(draft);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(draft), 300);
    return () => clearTimeout(t);
  }, [draft]);
  const preview = useQuery({
    queryKey: ['schedules', 'preview', projectId, saved?.id ?? '', debounced],
    queryFn: () => scheduleApi.preview(projectId, debounced, saved?.id),
    placeholderData: keepPreviousData,
  });
  const checks = preview.data?.checks ?? [];
  const errors = checks.filter((c) => c.level === 'error');
  const stale = debounced !== draft || preview.isFetching;
  const errAt = (key: string) => errors.find((c) => c.key === key)?.text;

  const save = useScheduleMutation(() =>
    saved ? scheduleApi.update(saved.id, draft) : scheduleApi.create(projectId, draft),
  );
  const dryRun = useScheduleMutation(() => scheduleApi.dryRun(projectId, draft, saved?.id));

  async function submit() {
    setProblems([]);
    try {
      await save.mutateAsync(undefined);
      const next = preview.data?.nextRuns[0];
      toast.success(
        saved ? 'Schedule saved' : 'Schedule created',
        `${draft.ticketId}${next ? ` · next run ${next.day} ${next.time}` : ''}`,
      );
      onClose();
    } catch (err) {
      const body = (err as { response?: { data?: ScheduleErrorBody } }).response?.data;
      setProblems(body?.problems?.length ? body.problems.map((p) => p.text) : [extractError(err)]);
    }
  }

  async function runDry() {
    setDry(null);
    setDryError(null);
    try {
      setDry(await dryRun.mutateAsync(undefined));
    } catch (err) {
      setDryError(extractError(err));
    }
  }

  const member = ais.find((m) => m.id === draft.memberId);
  const free = member ? Math.max(0, member.maxParallel - member.slotsInUse) : 0;
  const lockedTicket = saved
    ? 'Locked: a schedule stays on its ticket'
    : opts.ticketId
      ? 'Locked: opened from the ticket'
      : undefined;
  const addPeople = people.filter((p) => p.name !== me && !draft.notifyPeople.includes(p.name));

  return (
    <div className="ai-overlay" style={{ zIndex: 1000 }} data-testid="schedule-editor">
      <div className="sc-editor ai-modal ai-root" role="dialog" aria-label={saved ? 'Edit schedule' : 'New schedule'}>
        <div className="sc-editor-head">
          <span style={{ color: '#2E6F40', display: 'flex' }}>
            <CalendarIcon size={18} />
          </span>
          <h2 className="ai-modal-title">{saved ? 'Edit schedule' : 'New schedule'}</h2>
          <button
            type="button"
            className="ai-icobtn"
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto' }}
          >
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="sc-editor-body">
          <div className="sc-form">
            {!saved && (
              <div className="sc-templates" data-testid="templates">
                <span className="sc-templates-label">START FROM</span>
                {SCHEDULE_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="sc-template"
                    title={t.hint}
                    onClick={() => set(t.patch)}
                    data-testid={`template-${t.id}`}
                  >
                    {t.label}
                    <span>{t.hint}</span>
                  </button>
                ))}
              </div>
            )}
            <Section title="Task" sub="What the team works on." id="sec-task">
              <TicketPicker
                tickets={tickets}
                value={draft.ticketId}
                onChange={(id) => set({ ticketId: id })}
                locked={lockedTicket}
                invalid={!!draft.ticketId && !!errAt('ticket')}
              />
              {errAt('ticket') && draft.ticketId && <div className="ai-error-text">{errAt('ticket')}</div>}
            </Section>

            <Section title="When" sub="Time zone follows the schedule, not your browser." id="sec-when">
              <Seg
                value={draft.kind}
                options={[
                  { id: 'once', label: 'Once' },
                  { id: 'repeat', label: 'Repeat' },
                ]}
                onChange={(kind) => set({ kind })}
                testId="kind"
              />
              {draft.kind === 'repeat' ? (
                <div className="sc-row">
                  <Field label="REPEAT ON">
                    <div className="sc-days">
                      {DAY_NAMES.map((d, i) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={draft.days.includes(i)}
                          className={draft.days.includes(i) ? 'sc-day-on' : ''}
                          onClick={() =>
                            set({
                              days: toggleNumber(draft.days, i),
                            })
                          }
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </Field>
                  <Field label="AT">
                    <div className="sc-input-icon">
                      <ClockIcon size={14} />
                      <TimeField
                        value={draft.time}
                        onChange={(time) => set({ time })}
                        testId="time"
                        label="Time of day"
                        width={140}
                      />
                    </div>
                  </Field>
                </div>
              ) : (
                <Field label="RUN ON">
                  <div className="sc-input-icon" style={{ maxWidth: 260 }}>
                    <CalendarIcon size={14} />
                    <input
                      type="datetime-local"
                      className={`ai-input ${errAt('when') ? 'ai-input-error' : ''}`}
                      value={draft.runAt}
                      onChange={(e) => set({ runAt: e.target.value })}
                      data-testid="run-at"
                    />
                  </div>
                </Field>
              )}
              {draft.kind === 'once' && errAt('when') && <div className="ai-error-text">{errAt('when')}</div>}
              {draft.kind === 'repeat' && errAt('when') && <div className="ai-error-text">{errAt('when')}</div>}
              <Field label="TIME ZONE">
                <ZoneSelect zones={zones} value={draft.tz} onChange={(tz) => set({ tz })} testId="tz" />
              </Field>
              <div className="sc-row">
                {draft.kind === 'repeat' && (
                  <Field label="ENDS">
                    <div className="sc-inline">
                      <Seg
                        value={draft.ends}
                        options={[
                          { id: 'never', label: 'Never' },
                          { id: 'after', label: 'After runs' },
                          { id: 'on_date', label: 'On date' },
                        ]}
                        onChange={(ends) => set({ ends })}
                        testId="ends"
                      />
                      {draft.ends === 'after' && (
                        <input
                          type="number"
                          min={1}
                          className="ai-input"
                          style={{ width: 80 }}
                          value={draft.endsAfter ?? ''}
                          placeholder="runs"
                          onChange={(e) => set({ endsAfter: e.target.value ? Number(e.target.value) : null })}
                          data-testid="ends-after"
                        />
                      )}
                      {draft.ends === 'on_date' && (
                        <input
                          type="date"
                          className="ai-input"
                          style={{ width: 150 }}
                          value={draft.endsOn}
                          onChange={(e) => set({ endsOn: e.target.value })}
                          data-testid="ends-on"
                        />
                      )}
                    </div>
                  </Field>
                )}
                <Field label="ALLOWED WINDOW (OPTIONAL)">
                  <div className="sc-inline">
                    <span className="sc-win">{draft.kind === 'repeat' ? draft.time : draft.runAt.slice(11, 16)}</span>
                    <span className="ai-muted">to</span>
                    <TimeField
                      value={draft.windowEnd}
                      onChange={(windowEnd) => set({ windowEnd })}
                      testId="window-end"
                      label="Allowed window ends at"
                      allowEmpty
                    />
                    {draft.windowEnd && (
                      <button type="button" className="ai-link" onClick={() => set({ windowEnd: '' })}>
                        Clear
                      </button>
                    )}
                  </div>
                </Field>
              </div>
              {errAt('ends') && <div className="ai-error-text">{errAt('ends')}</div>}
              <div className="ai-hint">
                Starts at {draft.kind === 'repeat' ? draft.time : draft.runAt.slice(11, 16)} if the team is free.
                {draft.windowEnd
                  ? ` With a window, a late start is allowed until ${draft.windowEnd}.`
                  : ' Set a window to allow a late start.'}
              </div>
            </Section>

            <Section title="Who runs it" sub="Needs permission to take this ticket." id="sec-who">
              <Field label="TEAM">
                <MemberSelect
                  members={ais}
                  value={draft.memberId}
                  onChange={(id) => set({ memberId: id })}
                  invalid={!!draft.memberId && !!errAt('member')}
                  testId="member"
                />
              </Field>
              {member && (
                <div className="ai-muted" data-testid="member-status">
                  {PROVIDER_NAME[member.provider] ?? member.provider} · {member.status.label.toLowerCase()} · {free} of{' '}
                  {member.maxParallel} run{member.maxParallel === 1 ? '' : 's'} free
                </div>
              )}
              {draft.memberId && errAt('member') && <div className="ai-error-text">{errAt('member')}</div>}
              {!ais.length && (
                <div className="ai-hint" data-testid="no-ai">
                  No AI teams yet. Add one in AI team, then schedule it here.
                </div>
              )}
              <Field label="BACKUP TEAM (OPTIONAL)">
                <MemberSelect
                  members={ais.filter((m) => m.id !== draft.memberId)}
                  value={draft.backupMemberId}
                  onChange={(id) => set({ backupMemberId: id })}
                  none="None. Skip when unavailable."
                  invalid={!!errAt('backup')}
                  testId="backup"
                />
              </Field>
              {errAt('backup') && <div className="ai-error-text">{errAt('backup')}</div>}
              <div className="ai-hint">Used if the first team is paused or cannot start.</div>
            </Section>

            <Section title="Limits" sub="Stops the run if reached." id="sec-limits">
              <div className="sc-row">
                <Field label="STOP AFTER">
                  <MenuSelect
                    label="Stop after"
                    testId="stop-after"
                    style={{ width: 140 }}
                    value={String(draft.limits.stopAfterMin)}
                    options={[...new Set([...STOP_AFTER, draft.limits.stopAfterMin])]
                      .sort((a, b) => a - b)
                      .map((n) => ({ value: String(n), label: `${n} min` }))}
                    onChange={(v) => set({ limits: { ...draft.limits, stopAfterMin: Number(v) } })}
                  />
                </Field>
                <Field label="RETRY ON FAILURE">
                  <MenuSelect
                    label="Retry on failure"
                    testId="retries"
                    style={{ width: 140 }}
                    value={String(draft.limits.retries)}
                    options={[0, 1, 2, 3].map((n) => ({
                      value: String(n),
                      label: n === 0 ? 'No retry' : `${n} time${n === 1 ? '' : 's'}`,
                    }))}
                    onChange={(v) => set({ limits: { ...draft.limits, retries: Number(v) } })}
                  />
                </Field>
                {draft.limits.maxCost !== null && (
                  <Field label="MAX COST">
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      className="ai-input"
                      style={{ width: 140 }}
                      value={draft.limits.maxCost}
                      onChange={(e) =>
                        set({ limits: { ...draft.limits, maxCost: e.target.value ? Number(e.target.value) : null } })
                      }
                      data-testid="max-cost"
                    />
                    <span className="ai-muted">Applies when a run reports its cost.</span>
                  </Field>
                )}
              </div>
              {errAt('limits') && <div className="ai-error-text">{errAt('limits')}</div>}
            </Section>

            <Section title="If it cannot run on time" sub="Offline, paused or busy." id="sec-catchup">
              <label className="sc-radio-row">
                <input
                  type="radio"
                  name="catch-up"
                  checked={draft.catchUp === 'run'}
                  onChange={() => set({ catchUp: 'run' })}
                  data-testid="catch-run"
                />
                <span>
                  <b>Run when it is back</b>, up to
                </span>
                <select
                  className="ai-select"
                  style={{ width: 110 }}
                  value={draft.catchUpHours}
                  disabled={draft.catchUp !== 'run'}
                  onChange={(e) => set({ catchUpHours: Number(e.target.value) })}
                  data-testid="catch-hours"
                >
                  {[...new Set([...CATCH_UP_HOURS, draft.catchUpHours])]
                    .sort((a, b) => a - b)
                    .map((h) => (
                      <option key={h} value={h}>
                        {h < 1 ? `${h * 60} min` : `${h} hour${h === 1 ? '' : 's'}`}
                      </option>
                    ))}
                </select>
                <span>after, then tell me</span>
              </label>
              <label className="sc-radio-row">
                <input
                  type="radio"
                  name="catch-up"
                  checked={draft.catchUp === 'skip'}
                  onChange={() => set({ catchUp: 'skip' })}
                  data-testid="catch-skip"
                />
                <span>
                  <b>Skip this time</b> and tell me
                </span>
              </label>
              <label className="sc-radio-row">
                <input
                  type="radio"
                  name="catch-up"
                  checked={draft.catchUp === 'ask'}
                  onChange={() => set({ catchUp: 'ask' })}
                  data-testid="catch-ask"
                />
                <span>
                  <b>Ask me</b> before running late
                </span>
              </label>
              {errAt('catch_up') && <div className="ai-error-text">{errAt('catch_up')}</div>}
            </Section>

            <Section title="Tell me when" sub="Who is told, and about what." id="sec-notify">
              <div className="sc-inline" style={{ flexWrap: 'wrap' }}>
                {NOTIFY_OPTIONS.map((o) => {
                  const on = draft.notify.includes(o.key);
                  return (
                    <button
                      key={o.key}
                      type="button"
                      aria-pressed={on}
                      className={`sc-tog ${on ? 'sc-tog-on' : ''}`}
                      onClick={() =>
                        set({ notify: on ? draft.notify.filter((k) => k !== o.key) : [...draft.notify, o.key] })
                      }
                      data-testid={`notify-${o.key}`}
                    >
                      {on && (
                        <span aria-hidden="true">
                          <LineIcon name="check" size={12} />
                        </span>
                      )}{' '}
                      {o.label}
                    </button>
                  );
                })}
              </div>
              <div className="sc-inline" style={{ flexWrap: 'wrap' }}>
                <span className="ai-hint">To {saved?.createdBy ?? me} (you).</span>
                {draft.notifyPeople.map((p) => (
                  <span key={p} className="sc-person">
                    {p}
                    <button
                      type="button"
                      aria-label={`Do not tell ${p}`}
                      onClick={() => set({ notifyPeople: draft.notifyPeople.filter((x) => x !== p) })}
                    >
                      <CloseIcon size={10} />
                    </button>
                  </span>
                ))}
                {addPeople.length > 0 && (
                  <select
                    className="ai-select"
                    style={{ width: 130 }}
                    value=""
                    onChange={(e) => e.target.value && set({ notifyPeople: [...draft.notifyPeople, e.target.value] })}
                    aria-label="Add people"
                    data-testid="notify-add"
                  >
                    <option value="">Add people</option>
                    {addPeople.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </Section>

            <Section title="Instruction" sub="Optional extra words for the team." id="sec-instruction">
              <textarea
                className="ai-textarea"
                placeholder="Keep the change small. Write the summary in plain words and name the test you added."
                value={draft.instruction}
                onChange={(e) => set({ instruction: e.target.value })}
                data-testid="instruction"
              />
            </Section>
          </div>

          <aside className="sc-side" data-testid="schedule-preview">
            <div className="ai-label">IN SHORT</div>
            <div className="sc-short" data-testid="preview-summary">
              {preview.data?.summary || <span className="ai-muted">Pick a ticket and a team to see the summary.</span>}
            </div>
            <div className="ai-label">NEXT 5 RUNS</div>
            <div data-testid="preview-runs">
              {preview.data?.nextRuns.length ? (
                preview.data.nextRuns.map((r) => (
                  <div key={r.at} className="sc-run">
                    <span>{r.day}</span>
                    <b className="ai-mono">{r.time}</b>
                    <span className="ai-muted sc-grow" style={{ textAlign: 'right' }}>
                      {r.in}
                    </span>
                  </div>
                ))
              ) : (
                <div className="ai-muted">No runs planned yet.</div>
              )}
            </div>
            <div className="ai-label">CHECKS</div>
            <div data-testid="preview-checks">
              {checks.map((c, i) => (
                <CheckLine key={`${c.key}-${i}`} level={c.level}>
                  {c.text}
                </CheckLine>
              ))}
              {!checks.length && <div className="ai-muted">Checking…</div>}
            </div>
            {(dryRun.isPending || dry || dryError) && (
              <>
                <div className="ai-label">DRY RUN</div>
                <div className="sc-dry" data-testid="dry-run-result">
                  {dryRun.isPending && (
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <span className="ai-spin" /> Asking {member?.name ?? 'the team'} for a plan…
                    </span>
                  )}
                  {dryError && <div className="ai-error-text">{dryError}</div>}
                  {dry && (
                    <>
                      <MarkdownRenderer plain>{dry.text}</MarkdownRenderer>
                      <div className="ai-muted" style={{ marginTop: 6 }}>
                        Plan by {dry.memberName ?? 'the team'}
                        {dry.cost > 0 ? ` · $${dry.cost.toFixed(3)}` : ''}. Nothing was changed.
                      </div>
                    </>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>

        <div className="sc-editor-foot">
          <button
            type="button"
            className="ai-btn"
            onClick={() => void runDry()}
            disabled={dryRun.isPending || !draft.ticketId || !draft.memberId}
            data-testid="dry-run"
          >
            <FlaskIcon size={14} /> Dry run
          </button>
          <span className="ai-muted">Shows what the lead would plan. Changes nothing.</span>
          <span className="sc-grow" />
          {problems.length > 0 && (
            <span className="ai-error-text" data-testid="save-problems" style={{ maxWidth: 360 }}>
              {problems.join(' ')}
            </span>
          )}
          <button type="button" className="ai-btn" onClick={onClose} data-testid="editor-cancel">
            Cancel
          </button>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            onClick={() => void submit()}
            disabled={save.isPending || errors.length > 0 || stale || !preview.data}
            data-testid="editor-save"
          >
            <CheckCircleIcon size={14} /> {saved ? 'Save' : 'Create schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
