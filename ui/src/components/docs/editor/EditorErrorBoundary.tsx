import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
  /** Bumped by "Reload the editor" so the editor mounts again from the saved draft. */
  attempt: number;
}

/**
 * Keeps a failure inside the editor from blanking the whole app (docs ED-9): the edit screen stays, with a note and a
 * button that mounts the editor again. The draft is kept by the edit screen, so nothing typed before is lost.
 * @param props.children - The editor.
 */
export class EditorErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('Docs editor failed', error);
  }

  render() {
    const { error, attempt } = this.state;
    if (!error)
      return (
        <div key={attempt} style={{ display: 'contents' }}>
          {this.props.children}
        </div>
      );
    return (
      <div
        role="alert"
        data-testid="editor-error"
        style={{
          margin: '40px auto',
          maxWidth: 520,
          padding: '16px 18px',
          borderRadius: 10,
          border: '1px solid #F2C9C1',
          background: '#FBE7E4',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontSize: 13.5,
          color: '#5B6B60',
        }}
      >
        <strong style={{ color: '#A5321E' }}>The editor stopped working</strong>
        <span>Your draft is saved. Reload the editor to carry on where you left off.</span>
        <span>
          <button
            type="button"
            className="st-btn st-btn-sm"
            onClick={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))}
          >
            Reload the editor
          </button>
        </span>
      </div>
    );
  }
}
