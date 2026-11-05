import { useState } from 'react';
import { aiApi, useAiSettings, useAiMutation } from '../../../api/ai';
import { extractError } from '../../../api/extractError';
import type { AiSettings } from '../../../types/ai';
import { Toggle } from '../aiUi';
import { NumberSetting, SettingRow } from '../settings/settingsUi';

/** How lessons are kept (AI v2): a lesson the lead proposes in its report is kept at once, or waits for a person. */
export function LessonsSettings({ projectId }: { projectId: string }) {
  const settings = useAiSettings(projectId);
  const patch = useAiMutation((body: Partial<AiSettings>) => aiApi.updateSettings(projectId, body));
  const [error, setError] = useState<string | null>(null);
  if (!settings.data) return null;
  const save = async (body: Partial<AiSettings>) => {
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
        title="Keep the lessons the AIs propose without asking me"
        hint="Off: a proposal is not in any prompt until you keep it."
      >
        <Toggle
          on={settings.data.lessonsMode === 'auto'}
          label="Keep the lessons the AIs propose without asking me"
          testId="lessons-auto"
          disabled={patch.isPending}
          onChange={(v) => void save({ lessonsMode: v ? 'auto' : 'review' })}
        />
      </SettingRow>
      <SettingRow title="Lessons in a run's prompt" hint="At most this many kept lessons go into the prompt of a run.">
        <NumberSetting
          value={settings.data.lessonsMax}
          min={0}
          label="Most kept lessons in a run's prompt"
          testId="lessons-max"
          disabled={patch.isPending}
          onSave={(n) => void save({ lessonsMax: n })}
        />
      </SettingRow>
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
