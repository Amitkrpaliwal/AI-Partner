import { RichContent } from './plan';

export * from './plan';

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  status?: 'modified' | 'new' | 'deleted';
  isOpen?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  richContent?: RichContent;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface Conversation {
  id: string;
  title: string;
  timestamp: Date;
}

export interface Model {
  id: string;
  name: string;
  provider: 'ollama' | 'lmstudio';
}