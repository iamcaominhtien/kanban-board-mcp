import { useState } from 'react';
import type { Project } from '../types';
import { AppLogo } from './icons';
import styles from './ProjectSidebar.module.css';
import { extractError } from '../api/extractError';

interface ProjectSidebarProps {
  projects: Project[];
  currentProjectId: string;
  onSelectProject: (id: string) => void;
  onCreateProject: (data: { name: string; prefix: string; color: string }) => Promise<void>;
  onDeleteProject: (id: string) => void;
  onOpenRecycleBin: () => void;
  onOpenMembers: () => void;
  onOpenSettings: () => void;
  wontDoCount: number;
  activeBoard: 'main' | 'idea';
  onBoardChange: (board: 'main' | 'idea') => void;
}

const PRESET_COLORS = ['#AACC2E', '#F472B6', '#F5C518', '#E8441A', '#5BB8F5', '#A78BFA', '#34D399', '#FB923C'];

export function ProjectSidebar({
  projects,
  currentProjectId,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onOpenRecycleBin,
  onOpenMembers,
  onOpenSettings,
  wontDoCount,
  activeBoard,
  onBoardChange,
}: ProjectSidebarProps) {
  const [showForm, setShowForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formPrefix, setFormPrefix] = useState('');
  const [formColor, setFormColor] = useState(PRESET_COLORS[0]);
  const [prefixError, setPrefixError] = useState<string | null>(null);

  function resetForm() {
    setFormName('');
    setFormPrefix('');
    setFormColor(PRESET_COLORS[0]);
  }

  function toggleBoard() {
    onBoardChange(activeBoard === 'main' ? 'idea' : 'main');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!formName.trim() || !formPrefix.trim()) return;
    const upperPrefix = formPrefix.trim().toUpperCase();
    setPrefixError(null);
    if (projects.some((p) => p.prefix.toUpperCase() === upperPrefix)) {
      setPrefixError('A project with this prefix already exists.');
      return;
    }
    try {
      await onCreateProject({ name: formName.trim(), prefix: upperPrefix, color: formColor });
      resetForm();
      setShowForm(false);
    } catch (err) {
      setPrefixError(`Error: ${extractError(err)}`);
    }
  }

  function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.stopPropagation();
    if (window.confirm(`Delete project "${name}"? All its tickets will be lost.`)) {
      onDeleteProject(id);
    }
  }

  return (
    <aside
      className={`${styles.sidebar} ${showForm ? styles.expanded : ''}`}
      aria-label="Project navigation"
    >
      {/* App Brand Header */}
      <div className={styles.logoArea} title="Kanban Board">
        <AppLogo size={22} />
        <span className={styles.logoText}>KANBAN</span>
      </div>

      {/* Projects List */}
      <div className={styles.projectSection}>
        <div className={styles.sectionLabel}>Projects</div>

        <nav className={styles.projectList}>
          {projects.map((project) => {
            const isActive = project.id === currentProjectId;
            return (
              <div
                key={project.id}
                role="button"
                tabIndex={0}
                title={`${project.name} (${project.prefix})`}
                className={`${styles.projectItem} ${isActive ? styles.projectItemActive : ''}`}
                onClick={() => onSelectProject(project.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectProject(project.id);
                  }
                }}
              >
                <span className={styles.projectDot} style={{ backgroundColor: project.color }} />
                <span className={styles.projectName}>{project.name}</span>
                <span className={styles.prefixBadge}>{project.prefix}</span>
                {projects.length > 1 && !isActive && (
                  <button
                    type="button"
                    className={styles.deleteBtn}
                    onClick={(e) => handleDelete(e, project.id, project.name)}
                    aria-label={`Delete ${project.name}`}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      {/* New Project Button or Form */}
      {showForm ? (
        <form className={styles.newProjectForm} onSubmit={handleSubmit}>
          <div className={styles.formTitle}>New Project</div>
          <input
            className={styles.formInput}
            type="text"
            placeholder="Project name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            autoFocus
          />
          <input
            className={styles.formInput}
            type="text"
            placeholder="Prefix (e.g. PROJ)"
            value={formPrefix}
            maxLength={6}
            onChange={(e) => {
              setFormPrefix(e.target.value.toUpperCase());
              setPrefixError(null);
            }}
          />
          {prefixError && <p className={styles.formError}>{prefixError}</p>}
          <div className={styles.swatchesRow}>
            {PRESET_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`${styles.swatch} ${formColor === color ? styles.swatchActive : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => setFormColor(color)}
                aria-label={`Color ${color}`}
              />
            ))}
          </div>
          <div className={styles.formActions}>
            <button type="submit" className={styles.submitBtn}>
              Create
            </button>
            <button
              type="button"
              className={styles.cancelBtn}
              onClick={() => {
                setShowForm(false);
                setPrefixError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className={styles.newProjectBtn}
          onClick={() => setShowForm(true)}
          title="New Project"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" style={{ flexShrink: 0 }}>
            <path d="M12 5V19M5 12H19" />
          </svg>
          <span className={styles.newProjectText}>New Project</span>
        </button>
      )}

      {/* Idea Space Toggle Card */}
      <div
        className={`${styles.ideaCard} ${activeBoard === 'idea' ? styles.ideaCardActive : ''}`}
        onClick={toggleBoard}
        role="button"
        tabIndex={0}
        title={activeBoard === 'idea' ? 'Idea Space (Active)' : 'Idea Space'}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleBoard();
          }
        }}
      >
        <svg className={styles.ideaIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z" />
        </svg>
        <span className={styles.ideaLabel}>Idea Space</span>
        <div className={`${styles.toggleTrack} ${activeBoard === 'idea' ? styles.toggleTrackActive : ''}`}>
          <div className={`${styles.toggleKnob} ${activeBoard === 'idea' ? styles.toggleKnobActive : ''}`} />
        </div>
      </div>

      <div className={styles.spacer} />

      {/* Bottom Actions */}
      <div className={styles.bottomNav}>
        <button
          type="button"
          className={styles.sidebarIconBtn}
          onClick={onOpenSettings}
          title="Settings"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2V5M12 19V22M4.2 4.2L6.3 6.3M17.7 17.7L19.8 19.8M2 12H5M19 12H22M4.2 19.8L6.3 17.7M17.7 6.3L19.8 4.2" />
          </svg>
          <span className={styles.navLabel}>Settings</span>
        </button>
        <button
          type="button"
          className={styles.sidebarIconBtn}
          onClick={onOpenMembers}
          title="Members"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="9" cy="8" r="3.2" />
            <path d="M3.5 19C3.5 15.5 6 13.5 9 13.5C12 13.5 14.5 15.5 14.5 19" />
            <circle cx="17" cy="9" r="2.6" />
            <path d="M15.5 13.6C18 13.6 20 15.3 20.3 18" />
          </svg>
          <span className={styles.navLabel}>Members</span>
        </button>
        <button
          type="button"
          className={styles.sidebarIconBtn}
          onClick={onOpenRecycleBin}
          title={wontDoCount > 0 ? `Recycle Bin (${wontDoCount})` : 'Recycle Bin'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M3 6H21M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6L18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
          </svg>
          <span className={styles.navLabel}>Recycle Bin</span>
          {wontDoCount > 0 && (
            <span className={styles.badgeCount}>{wontDoCount}</span>
          )}
        </button>
      </div>
    </aside>
  );
}
