import { StateCreator } from 'zustand';
import { API_BASE } from '../../lib/api';

export interface CoreMemory {
    userPreferences: Record<string, any>;
    projectConstraints: Record<string, string[]>;
}

export interface MemoryState {
    coreMemory: CoreMemory;
    tokenUsage: { current: number; limit: number };

    // Actions
    setTokenUsage: (current: number, limit: number) => void;
    setCoreMemory: (memory: CoreMemory) => void;
    fetchCoreMemory: () => Promise<void>;
}

export const memorySlice: StateCreator<MemoryState> = (set) => ({
    coreMemory: {
        userPreferences: {},
        projectConstraints: {},
    },
    tokenUsage: { current: 0, limit: 8000 },

    setTokenUsage: (current, limit) => {
        set({ tokenUsage: { current, limit } });
    },

    setCoreMemory: (memory) => {
        set({ coreMemory: memory });
    },

    fetchCoreMemory: async () => {
        try {
            const response = await fetch(`${API_BASE}/api/memory/core`);
            if (response.ok) {
                const json = await response.json(); // { memory: [{ category, key, value }] }

                // Transform DB rows to State Object
                const newMemory: CoreMemory = {
                    userPreferences: {},
                    projectConstraints: {}
                };

                if (json.memory && Array.isArray(json.memory)) {
                    json.memory.forEach((row: any) => {
                        try {
                            const val = JSON.parse(row.value);
                            if (row.category === 'userPreferences') {
                                newMemory.userPreferences[row.key] = val;
                            } else if (row.category === 'projectConstraints') {
                                newMemory.projectConstraints[row.key] = val;
                            }
                        } catch (e) {
                            // If value isn't JSON, use raw
                            if (row.category === 'userPreferences') {
                                newMemory.userPreferences[row.key] = row.value;
                            }
                        }
                    });
                }

                set({ coreMemory: newMemory });
            }
        } catch (error) {
            console.error('Failed to fetch core memory:', error);
        }
    },
});
