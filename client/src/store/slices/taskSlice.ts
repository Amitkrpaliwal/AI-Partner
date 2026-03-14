import { StateCreator } from 'zustand';

export interface Task {
    id: string;
    title: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    progress: number;
    message?: string;
}

export interface TaskState {
    activeTasks: Task[];

    // Actions
    addTask: (task: Task) => void;
    updateTaskProgress: (taskId: string, progress: number, message?: string) => void;
    completeTask: (taskId: string, result?: any) => void;
    failTask: (taskId: string, error?: string) => void;
}

export const taskSlice: StateCreator<TaskState> = (set) => ({
    activeTasks: [],

    addTask: (task) => {
        set((state) => ({
            activeTasks: [...state.activeTasks, task],
        }));
    },

    updateTaskProgress: (taskId, progress, message) => {
        set((state) => ({
            activeTasks: state.activeTasks.map((t) =>
                t.id === taskId ? { ...t, progress, message } : t
            ),
        }));
    },

    completeTask: (taskId) => {
        set((state) => ({
            activeTasks: state.activeTasks.filter((t) => t.id !== taskId),
        }));
    },

    failTask: (taskId, error) => {
        set((state) => ({
            activeTasks: state.activeTasks.map((t) =>
                t.id === taskId ? { ...t, status: 'failed', message: error } : t
            ),
        }));
    },
});
