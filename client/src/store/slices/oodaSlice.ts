import { StateCreator } from 'zustand';

export interface OODAEvent {
    phase: 'OBSERVE' | 'ORIENT' | 'DECIDE' | 'ACT' | 'REFLECT';
    message: string;
    timestamp: string; // ISO string
    details?: any;
}

export interface OODAState {
    debugMode: boolean;
    oodaLogs: OODAEvent[];
    activeError: {
        message: string;
        timestamp: string;
        analysis: string[];
    } | null;

    // Actions
    toggleDebugMode: () => void;
    addOODAEvent: (event: OODAEvent) => void;
    clearOODALogs: () => void;
    clearError: () => void;
}

export const oodaSlice: StateCreator<OODAState> = (set) => ({
    debugMode: false,
    oodaLogs: [],

    activeError: null,

    toggleDebugMode: () => {
        set((state) => ({ debugMode: !state.debugMode }));
    },

    addOODAEvent: (event) => {
        set((state) => {
            const newState: Partial<OODAState> = {
                oodaLogs: [event, ...state.oodaLogs].slice(0, 100)
            };

            // Auto-trigger error modal on REFLECT errors
            if (event.phase === 'REFLECT' && event.details?.error) {
                newState.activeError = {
                    message: event.message,
                    timestamp: event.timestamp,
                    analysis: []
                };
            }

            // Append analysis to active error if one exists
            if (state.activeError && event.phase === 'REFLECT' && !event.details?.error) {
                newState.activeError = {
                    ...state.activeError,
                    analysis: [...state.activeError.analysis, event.message]
                };
            }

            return newState;
        });
    },

    clearOODALogs: () => {
        set({ oodaLogs: [], activeError: null });
    },

    clearError: () => {
        set({ activeError: null });
    },
});
