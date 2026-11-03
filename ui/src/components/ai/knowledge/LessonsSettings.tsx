import { useState } from 'react';
import { usePatchProjectOps, useProjectOps, type ProjectOps } from '../../../api/aiProjectOps';
import { extractError } from '../../../api/extractError';
import { Toggle } from '../aiUi';
import { NumberSetting, SettingRow } from '../settings/settingsUi';

/** How lessons are made and used (design/screens/ai-operations.md, H): proposals at the end of a ticket, and how many go in a prompt. */
export function LessonsSettings({ projectId }: { projectId: string }) {
  const ops = useProjectOps(projectId);
  const patch = usePatchProjectOps(projectId);
  const [error, setError] = useState<string | null>(null);
  if (!ops.data) return null;
  const save = async (body: Partial<ProjectOps>) => {
    setError(null);
    try {
      await patch.mutateAsync(body);
    } catch (e) {
      setError(extractError(e));
    }
  };
  return (
    <div
      className="ai-card"
      data-testid="lessons-settings"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <SettingRow
        title="Let a light model propose lessons at the end of a ticket"
        hint="A proposal is not in any prompt until you keep it."
      >
        <Toggle
          on={ops.data.proposeLessons}
          label="Let a light model propose lessons at the end of a ticket"
          testId="ops-propose-lessons"
          disabled={patch.isPending}
          onChange={(v) => void save({ proposeLessons: v })}
        />
      </SettingRow>
      <SettingRow
        title="Let the AIs keep their own notes"
        hint="What a run learns (its role's notes, and notes on its ticket) reaches the next run at once, without being kept by you first."
      >
        <Toggle
          on={ops.data.aiNotes !== false}
          label="Let the AIs keep their own notes"
          testId="ops-ai-notes"
          disabled={patch.isPending}
          onChange={(v) => void save({ aiNotes: v })}
        />
      </SettingRow>
      <SettingRow title="Lessons in a run's prompt" hint="At most this many kept lessons go into the prompt of a run.">
        <NumberSetting
          value={ops.data.lessonsInPrompt}
          min={0}
          label="Most kept lessons in a run's prompt"
          testId="ops-lessons-in-prompt"
          disabled={patch.isPending}
          onSave={(n) => void save({ lessonsInPrompt: n })}
        />
      </SettingRow>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
