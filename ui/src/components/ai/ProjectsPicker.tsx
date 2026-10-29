import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiMember } from '../../types/ai';
import { useToast } from '../Toast';

/**
 * "Projects it can work in" (AI members step 3, safety A1 scope): one checkbox per project. Ticking one adds a linked
 * copy of the AI member there (same settings, key and budget); unticking removes it after its run. The project it was
 * added in always stays.
 */
export function ProjectsPicker({ member, disabled }: { member: AiMember; disabled?: boolean }) {
  const toast = useToast();
  const save = useAiMutation((ids: string[]) => aiApi.setProjects(member.id, ids));
  const projects = member.projects ?? [];
  const toggle = async (projectId: string, on: boolean) => {
    const ids = projects.filter((p) => (p.projectId === projectId ? on : p.on)).map((p) => p.projectId);
    try {
      await save.mutateAsync(ids);
    } catch (err) {
      toast.error("Couldn't change the projects", extractError(err));
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="ai-projects">
      <div className="ai-chips">
        {projects.map((p) => (
          <label
            key={p.projectId}
            className={`ai-choice ${p.on ? 'ai-choice-on' : ''}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            title={p.original ? 'Added here first; this project always stays' : undefined}
          >
            <input
              type="checkbox"
              checked={p.on}
              disabled={disabled || p.original || save.isPending}
              onChange={(e) => void toggle(p.projectId, e.target.checked)}
              data-testid={`ai-project-${p.name}`}
            />
            {p.name}
          </label>
        ))}
      </div>
      <div className="ai-muted">
        In each project it works on that project&apos;s tickets with the same settings, key and one shared budget.
      </div>
    </div>
  );
}
