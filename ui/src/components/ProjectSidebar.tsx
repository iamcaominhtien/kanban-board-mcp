import { useState } from 'react';
import type { Project } from '../types';
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

export function ProjectSidebar({ projects, currentProjectId, onSelectProject, onCreateProject, onDeleteProject, onOpenRecycleBin, onOpenMembers, onOpenSettings, wontDoCount, activeBoard, onBoardChange }: ProjectSidebarProps) {
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

  function toggleBoard(e: React.MouseEvent) {
    e.stopPropagation();
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

  function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (window.confirm('Delete this project? All its tickets will be lost.')) {
      onDeleteProject(id);
    }
  }

  return (
    <aside className={`${styles.sidebar} ${showForm ? styles.expanded : ''}`} aria-label="Project navigation">
      <div className={styles.logo}>
        <span className={styles.logoText}>KANBAN</span>
      </div>

      <nav className={styles.projectList}>
        <p className={styles.sectionLabel}>Projects</p>
        {projects.map((project) => (
          <div
            key={project.id}
            role="button"
            tabIndex={0}
            className={`${styles.projectItem} ${project.id === currentProjectId ? styles.active : ''}`}
            onClick={() => onSelectProject(project.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectProject(project.id);
              }
            }}
          >
            <span className={styles.dot} style={{ backgroundColor: project.color }} />
            <span className={styles.projectName}>{project.name}</span>
            <span className={styles.prefixBadge}>{project.prefix}</span>
            {project.id === currentProjectId && (
              <button
                type="button"
                className={`${styles.boardToggleSwitch} ${activeBoard === 'idea' ? styles.boardToggleOn : ''}`}
                onClick={toggleBoard}
                title={activeBoard === 'main' ? 'Switch to Idea Space 💡' : 'Switch to Main Board 📋'}
                aria-checked={activeBoard === 'idea'}
                role="switch"
              >
                <span className={styles.boardToggleKnob} />
              </button>
            )}
            {projects.length > 1 && (
              <button
                type="button"
                className={styles.deleteBtn}
                onClick={(e) => handleDelete(e, project.id)}
                aria-label={`Delete ${project.name}`}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </nav>

      <div className={styles.bottomSection}>
        <button
          type="button"
          className={styles.recycleBinBtn}
          onClick={onOpenSettings}
          title="Settings"
        >
          <span className={styles.recycleBinIcon}>⚙️</span>
          <span className={styles.recycleBinLabel}>Settings</span>
        </button>
        <button
          type="button"
          className={styles.recycleBinBtn}
          onClick={onOpenMembers}
          title="Project Members"
        >
          <span className={styles.recycleBinIcon}>👥</span>
          <span className={styles.recycleBinLabel}>Members</span>
        </button>
        <button
          type="button"
          className={styles.recycleBinBtn}
          onClick={onOpenRecycleBin}
          title="Recycle Bin"
        >
          <span className={styles.recycleBinIcon}>🗑</span>
          <span className={styles.recycleBinLabel}>Recycle Bin</span>
          {wontDoCount > 0 && (
            <span className={styles.recycleBinBadge}>{wontDoCount}</span>
          )}
        </button>
        {showForm ? (
          <form className={styles.newProjectForm} onSubmit={handleSubmit}>
            <p className={styles.formTitle}>New Project</p>
            <input
              className={styles.input}
              type="text"
              placeholder="Project name"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              autoFocus
            />
            <input
              className={styles.input}
              type="text"
              placeholder="Prefix (e.g. PROJ)"
              value={formPrefix}
              maxLength={6}
              onChange={(e) => { setFormPrefix(e.target.value.toUpperCase()); setPrefixError(null); }}
            />
            {prefixError && <p className={styles.errorText}>{prefixError}</p>}
            <div className={styles.colorSwatches}>
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
              <button type="submit" className={styles.submitBtn}>Create</button>
              <button type="button" className={styles.cancelBtn} onClick={() => { setShowForm(false); setPrefixError(null); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <button type="button" className={styles.newProjectBtn} onClick={() => setShowForm(true)}>
            +<span className={styles.newProjectLabel}> New Project</span>
          </button>
        )}
      </div>
    </aside>
  );
}
