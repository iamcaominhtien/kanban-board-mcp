// Flow › Map and the scope picker (AI v2): the person, the teams and the tickets, and the edges between them.

export type FlowTeamState = 'working' | 'waiting' | 'queued' | 'offline' | 'idle' | 'paused';

export interface FlowRole {
  id: string;
  name: string;
  color: string;
  /** Times the lead called this role in the range. */
  calls: number;
}

export interface FlowTeamNode {
  id: string;
  name: string;
  color: string | null;
  state: FlowTeamState;
  runs: number;
  tickets: number;
  roles: FlowRole[];
}

export interface FlowTicketNode {
  id: string;
  title: string;
  status: string;
  type: string;
  parentId: string | null;
  blockedBy: string[];
  /** Only drawn because a worked ticket points at it (a parent or a blocker). */
  context: boolean;
  live: 'working' | 'waiting' | null;
  teams: string[];
}

/** take: a team took a ticket · note: one team wrote to another · ask/answer: a question to you and your answer. */
export type FlowEdgeKind = 'take' | 'note' | 'ask' | 'answer' | 'child' | 'blocked';

export interface FlowEdge {
  id: string;
  kind: FlowEdgeKind;
  from: string;
  to: string;
  count: number;
  live?: boolean;
  waiting?: boolean;
  tickets: string[];
  label?: string;
}

export interface FlowMapData {
  range: string;
  since: string | null;
  until: string | null;
  now: string;
  scope: { ticketId: string | null; teamId: string | null };
  pausedAll: boolean;
  you: { asked: number; waiting: number };
  teams: FlowTeamNode[];
  tickets: FlowTicketNode[];
  edges: FlowEdge[];
  runs: number;
  truncated: boolean;
  allTeams: number;
}

export interface FlowScopes {
  teams: { id: string; name: string; color: string | null; runs: number; live: boolean }[];
  stories: {
    id: string;
    title: string;
    status: string;
    tickets: number;
    done: number;
    live: boolean;
    waiting: boolean;
  }[];
  tickets: {
    id: string;
    title: string;
    status: string;
    type: string;
    storyId: string | null;
    live: boolean;
    waiting: boolean;
    at: string;
    teams: string[];
  }[];
}
