export interface User {
    id: string;
    name: string;
    avatar?: string;
    role?: string;
}

export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: string;
    attachments?: any[];
}
