// Converted from the canvas design: AiTimelineCases, AiResources and AiTicketWork (design/source/*.dc.html).
// Static markup with the design's own mock numbers; to be made data-driven when it is connected to the board.
import './designBlocks.css';

/** RunPanelDesign: a block of the canvas design, as drawn (mock data). */
export function RunPanelDesign() {
  return (
    <div className="dz dz-tw">
      <div style={{ padding: '14px 20px 14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '15px', color: '#1E2A22', fontWeight: '700', lineHeight: '1.5' }}>Run #3</span>
          <span className="ai-chip" style={{ background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }}>
            <span
              className="ai-pulse"
              style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#2E6F40', flexShrink: '0' }}
            />
            Running
          </span>
          <span style={{ flex: '1' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button className="st-btn st-btn-sm" style={{}}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M9 6V18" />
                <path d="M15 6V18" />
              </svg>
              Pause
            </button>
            <button className="st-btn st-btn-danger-outline st-btn-sm" style={{}}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Cancel run
            </button>
            <button className="st-btn st-btn-sm" style={{}}>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M7 10L10 13L7 16" />
                <path d="M12 16H17" />
              </svg>
              Open in terminal
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              position: 'relative',
              display: 'inline-flex',
              width: '18px',
              height: '18px',
              borderRadius: '5px',
              background: '#DCEEE1',
              color: '#2E6F40',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: '0',
            }}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
              <path
                d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
              />
            </svg>
            <span
              style={{
                position: 'absolute',
                right: '-4px',
                bottom: '-4px',
                width: '11px',
                height: '11px',
                borderRadius: '50%',
                background: '#1E2A22',
                border: '1.5px solid #FFFFFF',
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#FFFFFF',
              }}
            >
              <svg width="7" height="7" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                <path
                  d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"
                  fill="currentColor"
                />
              </svg>
            </span>
          </span>
          <span style={{ fontSize: '12px', color: '#1E2A22', fontWeight: '600', lineHeight: '1.5' }}>
            Claude Code · Backend
          </span>
          <span style={{ fontSize: '12px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>·</span>
          <span style={{ fontSize: '12px', color: '#5B6B60', fontWeight: '400', lineHeight: '1.5' }}>
            started 12:41 by An Nguyen
          </span>
          <span style={{ fontSize: '12px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>·</span>
          <span
            style={{
              fontSize: '12px',
              color: '#2E6F40',
              fontWeight: '700',
              lineHeight: '1.5',
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            3m 12s
          </span>
          <span style={{ fontSize: '12px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>·</span>
          <span style={{ fontSize: '12px', color: '#5B6B60', fontWeight: '400', lineHeight: '1.5' }}>Not metered</span>
          <span style={{ fontSize: '12px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>·</span>
          <span
            style={{
              fontSize: '11.5px',
              color: '#1E2A22',
              fontWeight: '600',
              lineHeight: '1.5',
              fontFamily: "'JetBrains Mono',monospace",
            }}
          >
            ai/kan-142-drag-handle
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '22px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1', minWidth: '0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div className="td-label" style={{}}>
                Steps
              </div>
              <span style={{ fontSize: '11px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>6 of ~14</span>
              <span style={{ flex: '1' }} />
              <button className="mc-link">Collapse all</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ borderBottom: '1px solid #EEF3EF', padding: '6px 4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#9AA8A0"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M9 6L15 12L9 18" />
                  </svg>
                  <span style={{ color: '#2E6F40', display: 'flex' }}>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: '0' }}
                    >
                      <path d="M5 12.5L10 17.5L19 7" />
                    </svg>
                  </span>
                  <span
                    style={{
                      fontSize: '12.5px',
                      color: '#1E2A22',
                      fontWeight: '500',
                      flex: '1',
                      minWidth: '0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    Read the ticket and 4 acceptance criteria
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#9AA8A0' }}>
                    12:41:02
                  </span>
                </div>
              </div>
              <div style={{ borderBottom: '1px solid #EEF3EF', padding: '6px 4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#9AA8A0"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M9 6L15 12L9 18" />
                  </svg>
                  <span style={{ color: '#2E6F40', display: 'flex' }}>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: '0' }}
                    >
                      <path d="M5 12.5L10 17.5L19 7" />
                    </svg>
                  </span>
                  <span
                    style={{
                      fontSize: '12.5px',
                      color: '#1E2A22',
                      fontWeight: '500',
                      flex: '1',
                      minWidth: '0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    Edited <span className="m-code">CardFooter.tsx</span>
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px' }}>
                    <span style={{ color: '#2E6F40' }}>+24</span> <span style={{ color: '#C4432A' }}>−3</span>
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#9AA8A0' }}>
                    12:41:31
                  </span>
                </div>
              </div>
              <div style={{ borderBottom: '1px solid #EEF3EF', padding: '6px 4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#9AA8A0"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M6 9L12 15L18 9" />
                  </svg>
                  <span style={{ color: '#2E6F40', display: 'flex' }}>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: '0' }}
                    >
                      <path d="M5 12.5L10 17.5L19 7" />
                    </svg>
                  </span>
                  <span
                    style={{
                      fontSize: '12.5px',
                      color: '#1E2A22',
                      fontWeight: '500',
                      flex: '1',
                      minWidth: '0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    Ran <span className="m-code">npm test -- CardFooter</span> · exit 0
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#9AA8A0' }}>
                    12:42:05
                  </span>
                </div>
                <div className="mc-code" style={{ margin: '6px 0 4px 22px', fontSize: '11px', padding: '8px 10px' }}>
                  <span className="mc-c">{'$ npm test -- CardFooter'}</span>
                  {'\n PASS  src/CardFooter.test.tsx\n   ✓ renders the drag handle (12 ms)\n'}
                  <span className="mc-f">{'API_TOKEN=••••••••••••'}</span>{' '}
                  <span style={{ color: '#6E8676' }}>{'(redacted)'}</span>
                  {'\nTests: 2 passed, 2 total'}
                </div>
              </div>
              <div style={{ borderBottom: '1px solid #EEF3EF', padding: '6px 4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#9AA8A0"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M9 6L15 12L9 18" />
                  </svg>
                  <span style={{ color: '#2E6F40', display: 'flex' }}>
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ flexShrink: '0' }}
                    >
                      <path d="M5 12.5L10 17.5L19 7" />
                    </svg>
                  </span>
                  <span
                    style={{
                      fontSize: '12.5px',
                      color: '#1E2A22',
                      fontWeight: '500',
                      flex: '1',
                      minWidth: '0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    Created <span className="m-code">DragHandle.tsx</span>
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#2E6F40' }}>
                    +41
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#9AA8A0' }}>
                    12:42:44
                  </span>
                </div>
              </div>
              <div style={{ borderBottom: '1px solid #EEF3EF', padding: '6px 4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#9AA8A0"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M9 6L15 12L9 18" />
                  </svg>
                  <span
                    style={{
                      width: '12px',
                      height: '12px',
                      borderRadius: '50%',
                      border: '2px solid #2E6F4033',
                      borderTopColor: '#2E6F40',
                      animation: 'm-spin 0.7s linear infinite',
                      boxSizing: 'border-box',
                      flexShrink: '0',
                    }}
                  />
                  <span
                    style={{
                      fontSize: '12.5px',
                      color: '#1E2A22',
                      fontWeight: '600',
                      flex: '1',
                      minWidth: '0',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    Running <span className="m-code">npm run lint</span>
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#9AA8A0' }}>
                    12:43:30
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '236px', flexShrink: '0' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div className="td-label" style={{}}>
                  Files touched
                </div>
                <span style={{ flex: '1' }} />
                <span style={{ fontSize: '11px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>
                  3 changed
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5B6B60"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: '0' }}
                >
                  <path d="M6 3H14L19 8V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
                  <path d="M14 3V8H19" />
                </svg>
                <span
                  style={{
                    fontSize: '12px',
                    color: '#1E2A22',
                    fontWeight: '600',
                    lineHeight: '1.5',
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  CardFooter.tsx
                </span>
                <span style={{ flex: '1' }} />
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px' }}>
                  <span style={{ color: '#2E6F40' }}>+24</span> <span style={{ color: '#C4432A' }}>−3</span>
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5B6B60"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: '0' }}
                >
                  <path d="M6 3H14L19 8V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
                  <path d="M14 3V8H19" />
                </svg>
                <span
                  style={{
                    fontSize: '12px',
                    color: '#1E2A22',
                    fontWeight: '600',
                    lineHeight: '1.5',
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  DragHandle.tsx
                </span>
                <span style={{ flex: '1' }} />
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#2E6F40' }}>
                  +41 new
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#5B6B60"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ flexShrink: '0' }}
                >
                  <path d="M6 3H14L19 8V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
                  <path d="M14 3V8H19" />
                </svg>
                <span
                  style={{
                    fontSize: '12px',
                    color: '#1E2A22',
                    fontWeight: '600',
                    lineHeight: '1.5',
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  CardFooter.test.tsx
                </span>
                <span style={{ flex: '1' }} />
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: '10.5px', color: '#2E6F40' }}>
                  +18
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              <div className="td-label" style={{}}>
                Commands
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span
                  className="ai-chip"
                  style={{ background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M5 12.5L10 17.5L19 7" />
                  </svg>
                  exit 0
                </span>
                <span
                  style={{
                    fontSize: '11.5px',
                    color: '#1E2A22',
                    fontWeight: '500',
                    lineHeight: '1.5',
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  npm test -- CardFooter
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span
                  className="ai-chip"
                  style={{ background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }}
                >
                  <span
                    className="ai-pulse"
                    style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#2E6F40', flexShrink: '0' }}
                  />
                  now
                </span>
                <span
                  style={{
                    fontSize: '11.5px',
                    color: '#1E2A22',
                    fontWeight: '500',
                    lineHeight: '1.5',
                    fontFamily: "'JetBrains Mono',monospace",
                  }}
                >
                  npm run lint
                </span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
              <div className="td-label" style={{}}>
                Test results
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  className="ai-chip"
                  style={{ background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M5 12.5L10 17.5L19 7" />
                  </svg>
                  14 passed
                </span>
                <span
                  className="ai-chip"
                  style={{ background: '#FDF1EE', color: '#C4432A', border: '1px solid #F0C4B8' }}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: '0' }}
                  >
                    <path d="M12 3.5L22 20H2Z" />
                    <path d="M12 10V14" />
                    <path d="M12 17.2V17.3" />
                  </svg>
                  1 failed
                </span>
              </div>
              <span style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '400', lineHeight: '1.5' }}>
                Failing: <span className="m-code">DragHandle.focus</span>
              </span>
            </div>
          </div>
        </div>
        <div style={{ fontSize: '11px', color: '#9AA8A0', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: '0' }}
          >
            <path d="M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6Z" />
          </svg>
          Secrets, tokens and key-like strings are masked before the log is stored or shown.
        </div>
      </div>
    </div>
  );
}

/** RunCardDesign: a block of the canvas design, as drawn (mock data). */
export function RunCardDesign() {
  return (
    <div className="dz dz-tw">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span
          style={{
            position: 'relative',
            display: 'inline-flex',
            width: '28px',
            height: '28px',
            borderRadius: '8px',
            background: '#DCEEE1',
            color: '#2E6F40',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: '0',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
            <path
              d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </svg>
          <span
            style={{
              position: 'absolute',
              right: '-4px',
              bottom: '-4px',
              width: '11px',
              height: '11px',
              borderRadius: '50%',
              background: '#1E2A22',
              border: '1.5px solid #FFFFFF',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#FFFFFF',
            }}
          >
            <svg width="7" height="7" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
              <path
                d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"
                fill="currentColor"
              />
            </svg>
          </span>
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
          <span style={{ fontSize: '12.5px', color: '#1E2A22', fontWeight: '700', lineHeight: '1.5' }}>
            Run #3 in progress
          </span>
          <span style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '400', lineHeight: '1.5' }}>
            Started 12:41 · 3m 12s
          </span>
        </div>
        <span style={{ flex: '1' }} />
        <button className="mc-link">
          Open run
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: '0' }}
          >
            <path d="M9 6L15 12L9 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** RunHistoryDesign: a block of the canvas design, as drawn (mock data). */
export function RunHistoryDesign() {
  return (
    <div className="dz dz-tw">
      <div style={{ border: '1px solid #E3E8E5', borderRadius: '10px', overflow: 'hidden', background: '#FFFFFF' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '46px minmax(150px, 1.2fr) minmax(170px, 1.4fr) 104px 70px 96px minmax(120px, 1fr)',
            columnGap: '14px',
            alignItems: 'center',
            padding: '9px 16px',
            boxSizing: 'border-box',
            background: '#F6FAF7',
            borderBottom: '1px solid #E3E8E5',
          }}
        >
          <span className="td-label">Run</span>
          <span className="td-label">Agent</span>
          <span className="td-label">Started by</span>
          <span className="td-label">State</span>
          <span className="td-label">Time</span>
          <span className="td-label">Usage</span>
          <span className="td-label">Status change</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '46px minmax(150px, 1.2fr) minmax(170px, 1.4fr) 104px 70px 96px minmax(120px, 1fr)',
            columnGap: '14px',
            alignItems: 'center',
            padding: '9px 16px',
            boxSizing: 'border-box',
            borderBottom: '1px solid #EEF3EF',
          }}
        >
          <span
            style={{
              fontSize: '12px',
              color: '#1E2A22',
              fontWeight: '700',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            #4
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span
              style={{
                position: 'relative',
                display: 'inline-flex',
                width: '20px',
                height: '20px',
                borderRadius: '5px',
                background: '#DCEEE1',
                color: '#2E6F40',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: '0',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                <path
                  d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
              <span
                style={{
                  position: 'absolute',
                  right: '-4px',
                  bottom: '-4px',
                  width: '11px',
                  height: '11px',
                  borderRadius: '50%',
                  background: '#1E2A22',
                  border: '1.5px solid #FFFFFF',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#FFFFFF',
                }}
              >
                <svg width="7" height="7" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                  <path
                    d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            </span>
            <span
              style={{ fontSize: '12px', color: '#1E2A22', fontWeight: '600', lineHeight: '1.5', whiteSpace: 'nowrap' }}
            >
              Claude Code · Backend
            </span>
          </div>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Ask by An Nguyen, 12:46
          </span>
          <span style={{ justifySelf: 'start' }}>
            <span className="ai-chip" style={{ background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }}>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M5 12.5L10 17.5L19 7" />
              </svg>
              Finished
            </span>
          </span>
          <span
            style={{
              fontSize: '11.5px',
              color: '#5B6B60',
              fontWeight: '500',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            12s
          </span>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Not metered
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' }}>
            <span style={{ fontSize: '11.5px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>
              no changes (answer only)
            </span>
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '46px minmax(150px, 1.2fr) minmax(170px, 1.4fr) 104px 70px 96px minmax(120px, 1fr)',
            columnGap: '14px',
            alignItems: 'center',
            padding: '9px 16px',
            boxSizing: 'border-box',
            borderBottom: '1px solid #EEF3EF',
            background: '#FBFDFC',
          }}
        >
          <span
            style={{
              fontSize: '12px',
              color: '#1E2A22',
              fontWeight: '700',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            #3
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span
              style={{
                position: 'relative',
                display: 'inline-flex',
                width: '20px',
                height: '20px',
                borderRadius: '5px',
                background: '#DCEEE1',
                color: '#2E6F40',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: '0',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                <path
                  d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
              <span
                style={{
                  position: 'absolute',
                  right: '-4px',
                  bottom: '-4px',
                  width: '11px',
                  height: '11px',
                  borderRadius: '50%',
                  background: '#1E2A22',
                  border: '1.5px solid #FFFFFF',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#FFFFFF',
                }}
              >
                <svg width="7" height="7" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                  <path
                    d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            </span>
            <span
              style={{ fontSize: '12px', color: '#1E2A22', fontWeight: '600', lineHeight: '1.5', whiteSpace: 'nowrap' }}
            >
              Claude Code · Backend
            </span>
          </div>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Assigned by An Nguyen, 12:41
          </span>
          <span style={{ justifySelf: 'start' }}>
            <span className="ai-chip" style={{ background: '#F1F8F3', color: '#2E6F40', border: '1px solid #BFDCC7' }}>
              <span
                className="ai-pulse"
                style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#2E6F40', flexShrink: '0' }}
              />
              Running
            </span>
          </span>
          <span
            style={{
              fontSize: '11.5px',
              color: '#5B6B60',
              fontWeight: '500',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            3m 12s
          </span>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Not metered
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
                To Do
              </span>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9AA8A0"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M5 12H19" />
                <path d="M13 6L19 12L13 18" />
              </svg>
              <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
                In Progress
              </span>
            </span>
            <span style={{ fontSize: '11.5px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>
              · branch ai/kan-142-drag-handle · 3 files
            </span>
            <span style={{ flex: '1' }} />
            <button className="mc-link">
              Undo run’s changes
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M9 14L4 9L9 4" />
                <path d="M4 9H15a5 5 0 0 1 0 10H11" />
              </svg>
            </button>
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '46px minmax(150px, 1.2fr) minmax(170px, 1.4fr) 104px 70px 96px minmax(120px, 1fr)',
            columnGap: '14px',
            alignItems: 'center',
            padding: '9px 16px',
            boxSizing: 'border-box',
            borderBottom: '1px solid #EEF3EF',
          }}
        >
          <span
            style={{
              fontSize: '12px',
              color: '#1E2A22',
              fontWeight: '700',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            #2
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span
              style={{
                position: 'relative',
                display: 'inline-flex',
                width: '20px',
                height: '20px',
                borderRadius: '5px',
                background: '#DCEEE1',
                color: '#2E6F40',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: '0',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                <path
                  d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                />
              </svg>
              <span
                style={{
                  position: 'absolute',
                  right: '-4px',
                  bottom: '-4px',
                  width: '11px',
                  height: '11px',
                  borderRadius: '50%',
                  background: '#1E2A22',
                  border: '1.5px solid #FFFFFF',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#FFFFFF',
                }}
              >
                <svg width="7" height="7" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                  <path
                    d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            </span>
            <span
              style={{ fontSize: '12px', color: '#1E2A22', fontWeight: '600', lineHeight: '1.5', whiteSpace: 'nowrap' }}
            >
              Claude Code · Backend
            </span>
          </div>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Assigned by An Nguyen, Oct 21
          </span>
          <span style={{ justifySelf: 'start' }}>
            <span className="ai-chip" style={{ background: '#FDF3E3', color: '#B4571F', border: '1px solid #EBD3A4' }}>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7V12L15.5 14" />
              </svg>
              Timed out
            </span>
          </span>
          <span
            style={{
              fontSize: '11.5px',
              color: '#5B6B60',
              fontWeight: '500',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            30m 00s
          </span>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Not metered
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
                To Do
              </span>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9AA8A0"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M5 12H19" />
                <path d="M13 6L19 12L13 18" />
              </svg>
              <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
                In Progress
              </span>
            </span>
            <span style={{ fontSize: '11.5px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>
              · partial changes kept
            </span>
          </div>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '46px minmax(150px, 1.2fr) minmax(170px, 1.4fr) 104px 70px 96px minmax(120px, 1fr)',
            columnGap: '14px',
            alignItems: 'center',
            padding: '9px 16px',
            boxSizing: 'border-box',
          }}
        >
          <span
            style={{
              fontSize: '12px',
              color: '#1E2A22',
              fontWeight: '700',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            #1
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
            <span
              style={{
                position: 'relative',
                display: 'inline-flex',
                width: '20px',
                height: '20px',
                borderRadius: '5px',
                background: '#DDEBF7',
                color: '#2F6FB0',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: '0',
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                <path
                  d="M5 18.5L12 5.5L19 18.5M8.8 14.5H15.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span
                style={{
                  position: 'absolute',
                  right: '-4px',
                  bottom: '-4px',
                  width: '11px',
                  height: '11px',
                  borderRadius: '50%',
                  background: '#1E2A22',
                  border: '1.5px solid #FFFFFF',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#FFFFFF',
                }}
              >
                <svg width="7" height="7" viewBox="0 0 24 24" style={{ flexShrink: '0' }}>
                  <path
                    d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"
                    fill="currentColor"
                  />
                </svg>
              </span>
            </span>
            <span
              style={{ fontSize: '12px', color: '#1E2A22', fontWeight: '600', lineHeight: '1.5', whiteSpace: 'nowrap' }}
            >
              Antigravity · Frontend
            </span>
          </div>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Assigned by Hoa Mai, Oct 20
          </span>
          <span style={{ justifySelf: 'start' }}>
            <span className="ai-chip" style={{ background: '#F1F3F1', color: '#5B6B60', border: '1px solid #DCE3DE' }}>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M6 6L18 18" />
                <path d="M18 6L6 18" />
              </svg>
              Cancelled
            </span>
          </span>
          <span
            style={{
              fontSize: '11.5px',
              color: '#5B6B60',
              fontWeight: '500',
              lineHeight: '1.5',
              fontFamily: 'JetBrains Mono,monospace',
            }}
          >
            1m 48s
          </span>
          <span
            style={{ fontSize: '11.5px', color: '#5B6B60', fontWeight: '500', lineHeight: '1.5', whiteSpace: 'nowrap' }}
          >
            Not metered
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
                To Do
              </span>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9AA8A0"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M5 12H19" />
                <path d="M13 6L19 12L13 18" />
              </svg>
              <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
                In Progress
              </span>
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9AA8A0"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ flexShrink: '0' }}
              >
                <path d="M5 12H19" />
                <path d="M13 6L19 12L13 18" />
              </svg>
              <span className="ac-chip" style={{ fontSize: '11px', padding: '1px 8px' }}>
                To Do
              </span>
            </span>
            <span style={{ fontSize: '11.5px', color: '#9AA8A0', fontWeight: '400', lineHeight: '1.5' }}>
              · status returned at cancel
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** NowAndTimelineDesign: a block of the canvas design, as drawn (mock data). */
export function NowAndTimelineDesign() {
  return (
    <div className="dz dz-tl">
      <div style={{ padding: '10px 12px' }}>
        <div
          style={{
            padding: '6px 10px',
            borderRadius: '8px',
            background: '#E6F2EA',
            fontSize: '12px',
            marginBottom: '6px',
          }}
        >
          <b>Now</b> &middot; Dev is working on run 2 &middot; Tester is queued
        </div>
        <div style={{ border: '1px solid #E3E8E5', borderRadius: '10px', overflow: 'hidden' }}>
          <svg
            viewBox="0 0 860 253"
            style={{
              width: '100%',
              height: 'auto',
              display: 'block',
              fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
            }}
            role="img"
          >
            <defs>
              <pattern id="tlhA" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="#FFFBEF" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="#F0DBA8" strokeWidth="3" />
              </pattern>
              <pattern id="tlhG" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="#F6F8F6" />
                <line x1="0" y1="0" x2="0" y2="6" stroke="#E3E8E5" strokeWidth="3" />
              </pattern>
              <marker
                id="ah_assign"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#2F6FB0" />
              </marker>
              <marker
                id="ah_mention"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#7C5CD6" />
              </marker>
              <marker
                id="ah_handoff"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#2E6F40" />
              </marker>
              <marker
                id="ah_report"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#9AA8A0" />
              </marker>
              <marker
                id="ah_return"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#8A6A12" />
              </marker>
              <marker
                id="ah_back"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#C4432A" />
              </marker>
              <marker
                id="ah_ask"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#B8860B" />
              </marker>
              <marker
                id="ah_perm"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#B8860B" />
              </marker>
              <marker
                id="ah_answer"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#1E2A22" />
              </marker>
              <marker
                id="ah_approve"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#1E2A22" />
              </marker>
              <marker
                id="ah_auto"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#7C5CD6" />
              </marker>
              <marker
                id="ah_denied"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#C4432A" />
              </marker>
              <marker
                id="ah_doc"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#5B6B60" />
              </marker>
              <marker
                id="ah_tohuman"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                markerUnits="userSpaceOnUse"
                orient="auto"
              >
                <path d="M0 0L10 5L0 10z" fill="#B8860B" />
              </marker>
            </defs>
            <line x1="192.3" y1="46" x2="192.3" y2="236.0" stroke="#D5DED8" strokeWidth="1.4" strokeDasharray="2 4" />
            <line x1="457" y1="46" x2="457" y2="236.0" stroke="#D5DED8" strokeWidth="1.4" strokeDasharray="2 4" />
            <line x1="721.7" y1="46" x2="721.7" y2="236.0" stroke="#D5DED8" strokeWidth="1.4" strokeDasharray="2 4" />
            <text x="46" y="67.5" fontSize="10" fill="#6B7A70" textAnchor="end">
              10:00
            </text>
            <text x="46" y="130.5" fontSize="10" fill="#6B7A70" textAnchor="end">
              10:15
            </text>
            <text x="46" y="193.5" fontSize="10" fill="#6B7A70" textAnchor="end">
              10:30
            </text>
            <g>
              <rect x="141.3" y="4" width="102" height="40" rx="9" fill="#E6F2EA" stroke="#2E6F40" strokeWidth="1.5" />
              <text x="154.3" y="28" fontSize="10" fontWeight="800" fill="#1F5A31" textAnchor="middle">
                DV
              </text>
              <text x="167.3" y="29" fontSize="12" fontWeight="700" fill="#1F5A31">
                Dev
              </text>
              <circle cx="234.3" cy="16" r="4" fill="#2E6F40" />
              <circle cx="234.3" cy="16" r="4" fill="none" stroke="#2E6F40" strokeWidth="1.5" className="tl-anim">
                <animate attributeName="r" values="4;9" dur="1.6s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.7;0" dur="1.6s" repeatCount="indefinite" />
              </circle>
            </g>
            <g>
              <rect x="406" y="4" width="102" height="40" rx="9" fill="#FEF3D9" stroke="#B8860B" strokeWidth="1.5" />
              <text x="419" y="28" fontSize="10" fontWeight="800" fill="#7A5A06" textAnchor="middle">
                TS
              </text>
              <text x="432" y="29" fontSize="12" fontWeight="700" fill="#7A5A06">
                Tester
              </text>
              <circle cx="499" cy="16" r="4" fill="#5B6B60" />
            </g>
            <g>
              <rect x="670.7" y="4" width="102" height="40" rx="9" fill="#E9EAF7" stroke="#5B5FA8" strokeWidth="1.5" />
              <text x="683.7" y="28" fontSize="10" fontWeight="800" fill="#3F4390" textAnchor="middle">
                RV
              </text>
              <text x="696.7" y="29" fontSize="12" fontWeight="700" fill="#3F4390">
                Reviewer
              </text>
              <circle cx="763.7" cy="16" r="4" fill="#C7D2CB" />
            </g>
            <rect
              x="183.3"
              y="64.0"
              width="18"
              height="54.6"
              rx="5"
              fill="#E6F2EA"
              stroke="#2E6F40"
              strokeWidth="1.5"
            />
            <text x="207.3" y="75.0" fontSize="10" fontWeight="700" fill="#1F5A31">
              run 1
            </text>
            <path
              d="M 202.3 118.6 L 447 122.8"
              stroke="#2E6F40"
              strokeWidth="1.7"
              fill="none"
              markerEnd="url(#ah_handoff)"
            />
            <circle cx="324.7" cy="120.7" r="7.5" fill="#fff" stroke="#2E6F40" strokeWidth="1.4" />
            <text x="324.7" y="124.3" fontSize="10" fontWeight="800" fill="#2E6F40" textAnchor="middle">
              &rsaquo;
            </text>
            <rect
              x="448"
              y="122.8"
              width="18"
              height="109.2"
              rx="5"
              fill="url(#tlhG)"
              stroke="#9AA8A0"
              strokeWidth="1.5"
              strokeDasharray="4 3"
            />
            <rect
              x="183.3"
              y="156.4"
              width="18"
              height="75.6"
              rx="5"
              fill="#E6F2EA"
              stroke="#2E6F40"
              strokeWidth="1.5"
            />
            <g className="tl-anim">
              <rect x="186.3" y="159.4" width="12" height="69.6" rx="3" fill="#2E6F40" opacity="0.18">
                <animate attributeName="opacity" values="0.1;0.32;0.1" dur="1.8s" repeatCount="indefinite" />
              </rect>
              <circle cx="192.3" cy="232.0" r="4" fill="#2E6F40">
                <animate attributeName="r" values="3;6;3" dur="1.4s" repeatCount="indefinite" />
              </circle>
            </g>
            <g className="tl-still">
              <circle cx="192.3" cy="232.0" r="4" fill="#2E6F40" />
            </g>
            <text x="207.3" y="167.4" fontSize="10" fontWeight="700" fill="#1F5A31">
              run 2
            </text>
            <g className="tl-anim">
              <path
                d="M 202.3 190.0 L 447 194.2"
                stroke="#2E6F40"
                strokeWidth="1.7"
                fill="none"
                strokeDasharray="5 4"
                markerEnd="url(#ah_handoff)"
              >
                <animate attributeName="stroke-dashoffset" from="18" to="0" dur="0.9s" repeatCount="indefinite" />
              </path>
            </g>
            <g className="tl-still">
              <path
                d="M 202.3 190.0 L 447 194.2"
                stroke="#2E6F40"
                strokeWidth="1.7"
                fill="none"
                strokeDasharray="5 4"
                markerEnd="url(#ah_handoff)"
              />
            </g>
            <g>
              <line x1="83" y1="232.0" x2="854" y2="232.0" stroke="#2E6F40" strokeWidth="1.4" strokeDasharray="3 3" />
              <rect x="10" y="221" width="73" height="22" rx="11" fill="#2E6F40" />
              <text x="46.5" y="236" fontSize="10" fontWeight="800" fill="#fff" textAnchor="middle">
                now 10:40
              </text>
              <g className="tl-anim">
                <circle cx="846" cy="232.0" r="4" fill="#2E6F40">
                  <animate attributeName="r" values="3;7;3" dur="1.6s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite" />
                </circle>
              </g>
              <g className="tl-still">
                <circle cx="846" cy="232.0" r="4" fill="#2E6F40" />
              </g>
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

/** ResourcesDesign: a block of the canvas design, as drawn (mock data). */
export function ResourcesDesign() {
  return (
    <div className="dz dz-rs">
      <div
        style={{
          border: '1px solid #E3E8E5',
          borderRadius: '10px',
          background: '#fff',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <b style={{ fontSize: '13px', flex: '1' }}>Resources</b>
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: '#1F5A31' }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: '#2E6F40',
                boxShadow: '0 0 0 3px rgba(46,111,64,0.22)',
                display: 'inline-block',
              }}
            />
            Live &middot; every 2 s
          </span>
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <div
            style={{
              flex: '1 1 0',
              minWidth: '120px',
              border: '1px solid #E3E8E5',
              borderRadius: '12px',
              background: '#fff',
              padding: '12px 14px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
            }}
          >
            <div className="id-h">CLI RAM now</div>
            <div style={{ fontSize: '22px', fontWeight: '800', color: '#1E2A22' }}>1.54 GB</div>
            <div className="st-hint" style={{ fontSize: '11.5px' }}>
              76% of the limit &middot; +0.4 GB it started
            </div>
            <div className="id-bar" style={{ marginTop: '6px' }}>
              <i style={{ width: '76%', background: '#B8860B' }} />
            </div>
          </div>
          <div
            style={{
              flex: '1 1 0',
              minWidth: '120px',
              border: '1px solid #E3E8E5',
              borderRadius: '12px',
              background: '#fff',
              padding: '12px 14px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
            }}
          >
            <div className="id-h">Peak</div>
            <div style={{ fontSize: '22px', fontWeight: '800', color: '#1E2A22' }}>1.56 GB</div>
            <div className="st-hint" style={{ fontSize: '11.5px' }}>
              this run
            </div>
          </div>
          <div
            style={{
              flex: '1 1 0',
              minWidth: '120px',
              border: '1px solid #E3E8E5',
              borderRadius: '12px',
              background: '#fff',
              padding: '12px 14px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
            }}
          >
            <div className="id-h">CPU</div>
            <div style={{ fontSize: '22px', fontWeight: '800', color: '#1E2A22' }}>38%</div>
            <div className="st-hint" style={{ fontSize: '11.5px' }}>
              of 1 core
            </div>
          </div>
          <div
            style={{
              flex: '1 1 0',
              minWidth: '120px',
              border: '1px solid #E3E8E5',
              borderRadius: '12px',
              background: '#fff',
              padding: '12px 14px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
            }}
          >
            <div className="id-h">Restarts</div>
            <div style={{ fontSize: '22px', fontWeight: '800', color: '#1E2A22' }}>0</div>
            <div className="st-hint" style={{ fontSize: '11.5px' }}>
              limit: 2
            </div>
          </div>
        </div>
        <svg
          viewBox="0 0 640 150"
          style={{
            width: '100%',
            height: 'auto',
            display: 'block',
            fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
          }}
          role="img"
          aria-label="RAM of each run over the last 5 minutes"
        >
          <line x1="44" y1="128.0" x2="628" y2="128.0" stroke="#EEF3EF" />
          <text x="36" y="131.5" fontSize="10" fill="#6B7A70" textAnchor="end">
            0.0 GB
          </text>
          <line x1="44" y1="101.2" x2="628" y2="101.2" stroke="#EEF3EF" />
          <text x="36" y="104.7" fontSize="10" fill="#6B7A70" textAnchor="end">
            0.5 GB
          </text>
          <line x1="44" y1="74.4" x2="628" y2="74.4" stroke="#EEF3EF" />
          <text x="36" y="77.9" fontSize="10" fill="#6B7A70" textAnchor="end">
            1.0 GB
          </text>
          <line x1="44" y1="47.5" x2="628" y2="47.5" stroke="#EEF3EF" />
          <text x="36" y="51.0" fontSize="10" fill="#6B7A70" textAnchor="end">
            1.5 GB
          </text>
          <line x1="44" y1="20.7" x2="628" y2="20.7" stroke="#EEF3EF" />
          <text x="36" y="24.2" fontSize="10" fill="#6B7A70" textAnchor="end">
            2.0 GB
          </text>
          <text x="44.0" y="144" fontSize="10" fill="#6B7A70" textAnchor="middle">
            5 min ago
          </text>
          <text x="162.8" y="144" fontSize="10" fill="#6B7A70" textAnchor="middle">
            4
          </text>
          <text x="281.6" y="144" fontSize="10" fill="#6B7A70" textAnchor="middle">
            3
          </text>
          <text x="400.3" y="144" fontSize="10" fill="#6B7A70" textAnchor="middle">
            2
          </text>
          <text x="519.1" y="144" fontSize="10" fill="#6B7A70" textAnchor="middle">
            1
          </text>
          <text x="628.0" y="144" fontSize="10" fill="#6B7A70" textAnchor="middle">
            now
          </text>
          <line x1="44" y1="20.7" x2="628" y2="20.7" stroke="#C4432A" strokeWidth="1.3" strokeDasharray="5 3" />
          <text x="624" y="15.7" fontSize="10" fontWeight="700" fill="#A5321E" textAnchor="end">
            limit per run 2 GB
          </text>
          <polyline
            points="44.0,79.7 53.9,78.5 63.8,77.8 73.7,77.7 83.6,77.8 93.5,77.7 103.4,77.0 113.3,75.8 123.2,74.6 133.1,73.9 143.0,73.8 152.9,73.9 162.8,73.8 172.7,73.0 182.6,71.8 192.5,70.6 202.4,69.9 212.3,69.8 222.2,70.0 232.1,69.8 242.0,69.1 251.9,67.9 261.8,66.7 271.7,66.0 281.6,65.9 291.5,66.0 301.4,65.9 311.3,65.1 321.2,63.9 331.1,62.7 340.9,62.0 350.8,62.0 360.7,62.1 370.6,61.9 380.5,61.2 390.4,59.9 400.3,58.8 410.2,58.1 420.1,58.0 430.0,58.2 439.9,58.0 449.8,57.2 459.7,56.0 469.6,54.8 479.5,54.1 489.4,54.1 499.3,54.2 509.2,54.0 519.1,53.2 529.0,52.0 538.9,50.9 548.8,50.2 558.7,50.2 568.6,50.3 578.5,50.1 588.4,49.3 598.3,48.1 608.2,46.9 618.1,46.3 628.0,46.2"
            fill="none"
            stroke="#2E6F40"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <circle cx="628.0" cy="46.2" r="3.5" fill="#2E6F40" />
        </svg>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button className="st-btn st-btn-sm" style={{}}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: '0' }}
            >
              <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />
            </svg>
            Restart
          </button>
          <button className="st-btn st-btn-sm" style={{ color: '#C4432A', borderColor: '#E8B5A8' }}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ flexShrink: '0' }}
            >
              <rect x="4" y="5" width="16" height="14" rx="1.5" />
            </svg>
            Stop
          </button>
          <span className="st-hint" style={{ fontSize: '11.5px' }}>
            Same actions as in the Resources tab. Open from the run, the ticket&rsquo;s AI activity or the Now card.
          </span>
        </div>
      </div>
    </div>
  );
}

/** RestartNoticeDesign: a block of the canvas design, as drawn (mock data). */
export function RestartNoticeDesign() {
  return (
    <div className="dz dz-rs">
      <div
        style={{
          padding: '11px 13px',
          border: '1px solid #F0CDA0',
          borderRadius: '10px',
          background: '#FFF4E5',
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-start',
        }}
      >
        <span style={{ color: '#8A4B08', display: 'flex', marginTop: '1px' }}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#8A4B08"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: '0' }}
          >
            <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />
          </svg>
        </span>
        <div style={{ flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '13px', fontWeight: '700', color: '#8A4B08' }}>
            Restarted automatically at 10:50
          </span>
          <span style={{ fontSize: '12.5px', lineHeight: '1.5', color: '#3A2A1E' }}>
            It reached <b>2.05 GB</b>, over the 2 GB limit, so the system restarted it. It continues from its session.{' '}
            <b>Restart 1 of 2</b>: after the second, the next time it goes over the limit the run is stopped.
          </span>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button className="st-btn st-btn-sm" style={{}}>
              Open run
            </button>
            <button className="st-btn st-btn-sm" style={{}}>
              Raise limit
            </button>
            <span className="st-hint" style={{ fontSize: '11.5px', alignSelf: 'center' }}>
              Seen by: Dev, An Nguyen
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** StopNoticeDesign: a block of the canvas design, as drawn (mock data). */
export function StopNoticeDesign() {
  return (
    <div className="dz dz-rs">
      <div
        style={{
          padding: '11px 13px',
          border: '1px solid #F0C4B8',
          borderRadius: '10px',
          background: '#FDF3F0',
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-start',
        }}
      >
        <span style={{ color: '#A5321E', display: 'flex', marginTop: '1px' }}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#A5321E"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ flexShrink: '0' }}
          >
            <rect x="4" y="5" width="16" height="14" rx="1.5" />
          </svg>
        </span>
        <div style={{ flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontSize: '13px', fontWeight: '700', color: '#A5321E' }}>Stopped automatically at 10:58</span>
          <span style={{ fontSize: '12.5px', lineHeight: '1.5', color: '#3A2A1E' }}>
            It went over the 2 GB limit again after 2 restarts (peak <b>2.31 GB</b>). Partial work in the folder is
            kept. The ticket stays assigned to PM.
          </span>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button className="st-btn st-btn-primary st-btn-sm" style={{}}>
              Retry
            </button>
            <button className="st-btn st-btn-sm" style={{}}>
              Raise limit to 3 GB
            </button>
            <button className="st-btn st-btn-sm" style={{}}>
              Open run
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
