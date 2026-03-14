import { StateCreator } from 'zustand';

export interface ActiveModel {
    provider: string; // 'ollama' | 'lmstudio'
    model: string;
}

export interface Config {
    theme: 'light' | 'dark';
    workspacePath: string;
    activeModel: ActiveModel;
}

// Types
export type ViewType = 'dashboard' | 'chat' | 'memory' | 'tasks' | 'skills' | 'settings' | 'knowledge' | 'agents' | 'routing' | 'toolMarketplace' | 'usage' | 'messaging' | 'learnedSkills' | 'voice' | 'files' | 'integrations' | 'proactive' | 'capabilities' | 'setup';

export interface ActiveAgent {
    slug: string;
    name: string;
    avatarColor: string;
}

export interface ConfigState {
    config: Config;
    currentView: ViewType;
    /** Currently pinned specialist agent — prepended as @slug to every chat message */
    activeAgent: ActiveAgent | null;

    // Actions
    setView: (view: ViewType) => void;
    updateConfig: (key: keyof Config, value: any) => void;
    setConfig: (config: Config) => void;
    setActiveAgent: (agent: ActiveAgent | null) => void;
}

export const configSlice: StateCreator<ConfigState> = (set) => ({
    currentView: 'dashboard',
    setView: (view) => set({ currentView: view }),
    activeAgent: null,
    setActiveAgent: (agent) => set({ activeAgent: agent }),

    config: {
        theme: 'dark',
        workspacePath: '/workspace',
        activeModel: {
            provider: 'ollama',
            model: 'llama3.2'
        }
    },

    updateConfig: (key, value) => {
        set((state) => ({
            config: {
                ...state.config,
                [key]: value,
            },
        }));
    },

    setConfig: (config) => {
        set({ config });
    }
});
