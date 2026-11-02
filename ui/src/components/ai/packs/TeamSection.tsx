import { useState } from 'react';
import { PackLibrary } from './PackLibrary';
import { TeamWizard } from './TeamWizard';
import './packs.css';

/** Role packs and giving the project a team (design/screens/ai-team-process.md, C and D). */
export function TeamSection({ projectId }: { projectId: string }) {
  const [wizard, setWizard] = useState(false);
  return (
    <div data-testid="team-section" data-project={projectId} className="pk-wrap">
      <div className="pk-head">
        <h3>Set up the AI team</h3>
        <span className="pk-grow" />
        <button className="ai-btn ai-btn-primary ai-btn-sm" onClick={() => setWizard(true)}>
          Set up the AI team
        </button>
      </div>
      <div className="ai-sub">
        Read the repository, get a suggested team, commands and workflow, and try them. Nothing is created until the
        last step.
      </div>
      <PackLibrary projectId={projectId} />
      {wizard && <TeamWizard projectId={projectId} onClose={() => setWizard(false)} />}
    </div>
  );
}
