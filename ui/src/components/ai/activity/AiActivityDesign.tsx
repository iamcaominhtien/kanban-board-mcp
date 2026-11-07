import {
  NowAndTimelineDesign,
  ResourcesDesign,
  RestartNoticeDesign,
  RunHistoryDesign,
  RunPanelDesign,
} from './design/designBlocks';

/**
 * The ticket's AI activity view as the canvas design draws it (design/source/AiTimelineCases, AiResources and
 * AiTicketWork), with the design's own mock numbers: the Now line and the Timeline of the ticket, the restart notice,
 * the Resources strip, the run panel and the table of runs. Connecting it to the board's data comes later.
 */
export function AiActivityDesign({ onOpenTimeline }: { onOpenTimeline?: () => void }) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 24px 24px' }}
      data-testid="ai-activity"
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onOpenTimeline}
          data-testid="open-in-timeline"
          style={{
            background: 'none',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            color: '#2E6F40',
          }}
        >
          Open in Timeline
        </button>
      </div>
      <NowAndTimelineDesign />
      <RestartNoticeDesign />
      <ResourcesDesign />
      <RunPanelDesign />
      <div style={{ overflowX: 'auto' }}>
        <RunHistoryDesign />
      </div>
    </div>
  );
}
