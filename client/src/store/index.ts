import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { conversationSlice, ConversationState } from './slices/conversationSlice';
import { oodaSlice, OODAState } from './slices/oodaSlice';
import { taskSlice, TaskState } from './slices/taskSlice';
import { configSlice, ConfigState } from './slices/configSlice';
import { memorySlice, MemoryState } from './slices/memorySlice';

export interface AppState extends
    ConversationState,
    OODAState,
    TaskState,
    ConfigState,
    MemoryState { }

export const useStore = create<AppState>()(
    persist(
        (...args) => ({
            ...conversationSlice(...args),
            ...oodaSlice(...args),
            ...taskSlice(...args),
            ...configSlice(...args),
            ...memorySlice(...args),
        }),
        {
            name: 'ai-coworker-storage-v2',
            storage: createJSONStorage(() => localStorage),
            partialize: (state) => ({
                // Only persist config and core memory
                config: state.config,
                coreMemory: state.coreMemory,
            }),
            // Custom merge because Maps need hydration from objects if we persisted them
            onRehydrateStorage: () => (_state) => {
                console.log('Hydration complete');
            }
        }
    )
);
