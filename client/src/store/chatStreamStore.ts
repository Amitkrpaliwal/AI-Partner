import { create } from 'zustand';

export interface StreamingMessage {
  id: string;
  content: string;
}

export interface StepProgress {
  step: number;
  tool: string;
  description: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: string;
  error?: string;
}

export interface ConvStreamState {
  streamingMessage: StreamingMessage | null;
  isExecuting: boolean;
  isHitlPending: boolean;
  executionProgress: StepProgress[];
}

const DEFAULT_CONV_STATE: ConvStreamState = {
  streamingMessage: null,
  isExecuting: false,
  isHitlPending: false,
  executionProgress: [],
};

interface ChatStreamStore {
  /** Per-conversation state keyed by LOCAL conversation ID */
  convStates: Record<string, ConvStreamState>;

  /**
   * Reverse map: server-side conversation UUID → local conversation ID.
   * Populated when 'conversation:id' socket event arrives.
   * Used to route incoming message:stream events to the correct local conv.
   */
  serverToLocal: Record<string, string>;

  /** Read state for a given local conversation ID (returns defaults if absent) */
  getConvState: (localConvId: string) => ConvStreamState;

  /** Resolve a server conv ID to a local conv ID, or null if unknown */
  resolveLocalId: (serverConvId: string) => string | null;

  /** Register server conv ID ↔ local conv ID mapping */
  bindServerConv: (serverConvId: string, localConvId: string) => void;

  /** Patch state for a specific local conversation */
  updateConv: (localConvId: string, patch: Partial<ConvStreamState>) => void;

  /** Clear stream state for a specific local conversation */
  clearConv: (localConvId: string) => void;
}

export const useChatStreamStore = create<ChatStreamStore>((set, get) => ({
  convStates: {},
  serverToLocal: {},

  getConvState: (localConvId) =>
    get().convStates[localConvId] ?? { ...DEFAULT_CONV_STATE },

  resolveLocalId: (serverConvId) =>
    get().serverToLocal[serverConvId] ?? null,

  bindServerConv: (serverConvId, localConvId) =>
    set((s) => ({
      serverToLocal: { ...s.serverToLocal, [serverConvId]: localConvId },
    })),

  updateConv: (localConvId, patch) =>
    set((s) => ({
      convStates: {
        ...s.convStates,
        [localConvId]: { ...(s.convStates[localConvId] ?? DEFAULT_CONV_STATE), ...patch },
      },
    })),

  clearConv: (localConvId) =>
    set((s) => ({
      convStates: {
        ...s.convStates,
        [localConvId]: { ...DEFAULT_CONV_STATE },
      },
    })),
}));
