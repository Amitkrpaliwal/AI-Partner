import { Paperclip, Mic, MicOff, ArrowUp, Square, MessageSquare, Target, Zap, X, FileText, Image as ImageIcon, FileCode, Music, ChevronDown, Bot } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { MessageBubble } from './chat/MessageBubble';
import { GoalExecutionLog } from './chat/GoalExecutionLog';
import { getSocket } from '@/lib/socket';
import { useStore } from '@/store'; // Global Store
import { useChatStreamStore, StepProgress } from '@/store/chatStreamStore';
import { API_BASE } from '@/lib/api';

type ChatMode = 'auto' | 'chat' | 'goal';

// StepProgress type imported from chatStreamStore

/** Counts up seconds from the moment it first mounts; stops when running=false */
function ElapsedTimer({ running }: { running: boolean }) {
  const [secs, setSecs] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    startRef.current = Date.now();
    setSecs(0);
    if (!running) return;
    const id = setInterval(() => setSecs(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);
  return <>{secs}s</>;
}

export function ChatArea() {
  const {
    conversations,
    activeConversationId,
    createConversation,
    addMessage,
    updateConversationTitle,
    activeAgent,
    setActiveAgent,
  } = useStore();

  const bottomRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');
  const [chatMode, setChatMode] = useState<ChatMode>('auto');
  const [approvalMode, setApprovalModeState] = useState<'none' | 'script' | 'all'>('script');
  const [approvalPopoverOpen, setApprovalPopoverOpen] = useState(false);
  const [serverConversationId, setLocalServerConvId] = useState<string | null>(null);
  const serverConversationIdRef = useRef<string | null>(null);
  // executionProgress lives in chatStreamStore — survives navigation (unlike useState)
  const executionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const [respondingAgent, setRespondingAgent] = useState<string | null>(null); // slug of last responding agent
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // ── Per-conversation stream state — isolated per conv, survives navigation ──
  const { getConvState, updateConv, clearConv } = useChatStreamStore();
  const convState = activeConversationId
    ? getConvState(activeConversationId)
    : { streamingMessage: null, isExecuting: false, isHitlPending: false, executionProgress: [] };
  const { streamingMessage, isExecuting, isHitlPending, executionProgress } = convState;

  const setIsExecuting   = (v: boolean) => { if (activeConversationId) updateConv(activeConversationId, { isExecuting: v }); };
  const setIsHitlPending = (v: boolean) => { if (activeConversationId) updateConv(activeConversationId, { isHitlPending: v }); };
  const clearStream      = ()           => { if (activeConversationId) clearConv(activeConversationId); };
  const setExecutionProgress = (updater: StepProgress[] | ((prev: StepProgress[]) => StepProgress[])) => {
    if (!activeConversationId) return;
    const current = getConvState(activeConversationId).executionProgress;
    const next = typeof updater === 'function' ? updater(current) : updater;
    updateConv(activeConversationId, { executionProgress: next });
  };

  // --- @mention autocomplete state ---
  const [mentionQuery, setMentionQuery] = useState<string | null>(null); // null = not in mention mode
  const [mentionProfiles, setMentionProfiles] = useState<any[]>([]); // all profiles (refreshed on focus)
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fetchMentionProfiles = () => {
    fetch(`${API_BASE}/api/agent-profiles`)
      .then(r => r.json())
      .then(d => setMentionProfiles(d.profiles || []))
      .catch(() => { });
  };

  // Fetch on mount and refresh when textarea gains focus (picks up newly seeded profiles)
  useEffect(() => { fetchMentionProfiles(); }, []);

  const AGENT_TYPE_COLORS: Record<string, string> = {
    research: '#3b82f6',
    execution: '#f97316',
    delivery: '#ec4899',
    synthesis: '#8b5cf6',
  };

  const filteredMentions = mentionQuery !== null
    ? mentionProfiles.filter(p =>
      p.slug.includes(mentionQuery.toLowerCase()) ||
      p.name.toLowerCase().includes(mentionQuery.toLowerCase())
    )
    : [];

  // Handle input change with @mention detection
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    // Check if cursor is inside an @word
    const cursor = e.target.selectionStart ?? val.length;
    const textBefore = val.slice(0, cursor);
    const match = textBefore.match(/@([\w-]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionIndex(0);
    } else {
      setMentionQuery(null);
    }
  };

  const insertMention = (profile: any) => {
    const cursor = textareaRef.current?.selectionStart ?? input.length;
    const textBefore = input.slice(0, cursor);
    const textAfter = input.slice(cursor);
    // Replace the partial @query with @slug + space
    const replaced = textBefore.replace(/@[\w-]*$/, `@${profile.slug} `);
    setInput(replaced + textAfter);
    setMentionQuery(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // --- File Upload State ---
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback((files: FileList | null) => {
    if (!files) return;
    const newFiles = Array.from(files).filter(f => {
      if (f.size > 25 * 1024 * 1024) {
        console.warn(`[Upload] ${f.name} exceeds 25MB limit`);
        return false;
      }
      const blocked = ['.exe', '.bat', '.cmd', '.msi', '.scr'];
      if (blocked.some(ext => f.name.toLowerCase().endsWith(ext))) {
        console.warn(`[Upload] ${f.name} blocked file type`);
        return false;
      }
      return true;
    });
    setAttachedFiles(prev => [...prev, ...newFiles].slice(0, 10));
  }, []);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index));
  }, []);

  const getFileIcon = (file: File) => {
    if (file.type.startsWith('image/')) return <ImageIcon size={12} />;
    if (file.type.startsWith('audio/')) return <Music size={12} />;
    if (file.type === 'application/pdf') return <FileText size={12} />;
    const codeExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.go', '.rs', '.json', '.yaml', '.yml', '.html', '.css'];
    if (codeExts.some(ext => file.name.endsWith(ext))) return <FileCode size={12} />;
    return <FileText size={12} />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  // --- Voice Recording ---
  const handleVoiceToggle = useCallback(async () => {
    if (isRecording) {
      // Stop — works for both SpeechRecognition and MediaRecorder paths
      (window as any)._chatRecognition?.stop();
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    // Primary path: browser Web Speech API (free, no API key, Chrome/Edge)
    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognitionAPI) {
      const recognition = new SpeechRecognitionAPI();
      (window as any)._chatRecognition = recognition;
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = navigator.language || 'en-US';

      recognition.onresult = (event: any) => {
        const text = event.results[0]?.[0]?.transcript;
        if (text) setInput(prev => prev ? `${prev} ${text}` : text);
      };
      recognition.onerror = (event: any) => {
        console.error('[Voice] SpeechRecognition error:', event.error);
        setIsRecording(false);
      };
      recognition.onend = () => setIsRecording(false);

      recognition.start();
      setIsRecording(true);
      return;
    }

    // Fallback: MediaRecorder + server-side Whisper (requires OPENAI_API_KEY)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (audioBlob.size === 0) return;

        setIsTranscribing(true);
        try {
          const res = await fetch(`${API_BASE}/api/voice/stt`, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/webm' },
            body: audioBlob
          });
          const data = await res.json();
          if (data.text) {
            setInput(prev => prev ? `${prev} ${data.text}` : data.text);
          } else if (data.error) {
            console.error('[Voice] STT error:', data.error);
            setInput(prev => prev || '⚠️ Voice transcription unavailable — set OPENAI_API_KEY to enable server-side STT');
          }
        } catch (err) {
          console.error('[Voice] STT error:', err);
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('[Voice] Microphone access denied:', err);
    }
  }, [isRecording]);

  // Keep refs in sync
  useEffect(() => {
    serverConversationIdRef.current = serverConversationId;
  }, [serverConversationId]);
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  // Fetch current approval mode from config (poll on focus so Telegram changes reflect)
  useEffect(() => {
    const load = () => {
      fetch(`${API_BASE}/api/config`)
        .then(r => r.json())
        .then(d => { if (d.execution?.approval_mode) setApprovalModeState(d.execution.approval_mode); })
        .catch(() => { });
    };
    load();
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);

  const handleApprovalModeChange = async (mode: 'none' | 'script' | 'all') => {
    setApprovalModeState(mode);
    setApprovalPopoverOpen(false);
    await fetch(`${API_BASE}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ execution: { approval_mode: mode } })
    }).catch(() => { });
  };

  // --- Stop Execution ---
  const handleStop = useCallback(() => {
    const socket = getSocket();
    socket.emit('message:cancel', { conversationId: serverConversationIdRef.current });
    setIsExecuting(false);
    setExecutionProgress([]);
    if (executionTimeoutRef.current) clearTimeout(executionTimeoutRef.current);
  }, []);

  // Ensure active conversation exists
  useEffect(() => {
    if (!activeConversationId) {
      createConversation('New Session');
    }
  }, [activeConversationId, createConversation]);

  // Initialize serverConversationId from loaded conversation or reset for new conversations
  useEffect(() => {
    if (activeConversationId) {
      const conv = conversations.get(activeConversationId);
      // If conversation was loaded from server, use its serverConversationId
      if (conv?.serverConversationId) {
        setLocalServerConvId(conv.serverConversationId);
        console.log('[Chat] Resuming server conversation:', conv.serverConversationId);
      } else {
        setLocalServerConvId(null);
      }
    }
  }, [activeConversationId, conversations]);

  // Listen for chat progress streaming events and conversation ID
  useEffect(() => {
    const socket = getSocket();

    const handleStepStart = (data: any) => {
      if (data.conversationId && serverConversationIdRef.current && data.conversationId !== serverConversationIdRef.current) return;
      console.log('[Chat] Step start:', data);
      setIsExecuting(true);
      setExecutionProgress(prev => [
        ...prev,
        {
          step: data.step,
          tool: data.tool,
          description: data.description,
          status: 'executing'
        }
      ]);
    };

    const handleStepComplete = (data: any) => {
      if (data.conversationId && serverConversationIdRef.current && data.conversationId !== serverConversationIdRef.current) return;
      console.log('[Chat] Step complete:', data);
      setExecutionProgress(prev =>
        prev.map(s =>
          s.step === data.step
            ? { ...s, status: data.success ? 'completed' : 'failed', result: data.result, error: data.error }
            : s
        )
      );
    };

    const handleExecutionDone = (data: any) => {
      if (data.conversationId && serverConversationIdRef.current && data.conversationId !== serverConversationIdRef.current) return;
      console.log('[Chat] Execution done:', data);
      setIsExecuting(false);
      if (data.agentSlug) setRespondingAgent(data.agentSlug);
      // Clear progress after a short delay so user can see final status
      setTimeout(() => setExecutionProgress([]), 3000);
    };

    // Receive server conversation ID for persistence
    const handleConversationId = (data: { conversationId: string }) => {
      // NOTE: We only want to set this if it's the first assignment OR if our active ID matches
      // but the event itself might not know what our activeChat is. 
      // The backend emits this during `message:send`. Let's trust it if we are currently null.
      if (data.conversationId && (!serverConversationIdRef.current || serverConversationIdRef.current !== data.conversationId)) {
        setLocalServerConvId(data.conversationId);
        console.log('[Chat] Server conversation ID:', data.conversationId);
        if (activeConversationIdRef.current) {
          useStore.getState().setServerConversationId(activeConversationIdRef.current, data.conversationId);
        }
      }
    };

    // NOTE: message:stream, execution:cancelled, message:error, goal:user-input-needed
    // are now handled by useGlobalChatSocket (App.tsx level) so they survive navigation.
    // ChatArea only keeps step-progress and conversation-id handlers here.

    // Handle execution cancelled — also clear local step progress
    const handleCancelled = (data: any) => {
      if (data?.conversationId && serverConversationIdRef.current && data.conversationId !== serverConversationIdRef.current) return;
      setExecutionProgress([]);
      clearStream();
      if (executionTimeoutRef.current) clearTimeout(executionTimeoutRef.current);
    };

    // Reload messages when a Telegram/Discord message is processed for this conversation.
    // Fires AFTER chat() completes so DB is fully written.
    const handleConversationUpdated = (data: { conversationId: string; agentSlug?: string }) => {
      const currentServerId = serverConversationIdRef.current;
      if (!currentServerId || data.conversationId !== currentServerId) return;
      if (data.agentSlug) setRespondingAgent(data.agentSlug);
      // Reload messages from server into the active conversation
      const conv = useStore.getState().conversations.get(activeConversationIdRef.current || '');
      const title = conv?.title || 'Conversation';
      useStore.getState().loadConversationFromServer(currentServerId, title);
    };

    socket.on('chat:step_start', handleStepStart);
    socket.on('chat:step_complete', handleStepComplete);
    socket.on('chat:execution_done', handleExecutionDone);
    socket.on('conversation:id', handleConversationId);
    socket.on('execution:cancelled', handleCancelled);
    socket.on('conversation:updated', handleConversationUpdated);

    // On remount / page refresh: ask server if any goal is still running.
    // Pass server conv ID if known (sidebar nav), omit if page was refreshed (server broadcasts to all).
    socket.emit('goal:request_sync', serverConversationIdRef.current
      ? { conversationId: serverConversationIdRef.current }
      : {}
    );

    return () => {
      socket.off('chat:step_start', handleStepStart);
      socket.off('chat:step_complete', handleStepComplete);
      socket.off('chat:execution_done', handleExecutionDone);
      socket.off('conversation:id', handleConversationId);
      socket.off('execution:cancelled', handleCancelled);
      socket.off('conversation:updated', handleConversationUpdated);
    };
  }, [activeConversationId, addMessage, clearStream]);

  const activeConversation = activeConversationId ? conversations.get(activeConversationId) : null;
  const messages = activeConversation?.messages || [];

  useEffect(() => {
    if (bottomRef.current && bottomRef.current.parentElement) {
      const container = bottomRef.current.parentElement;
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    }
  }, [messages.length, messages[messages.length - 1]?.content, executionProgress.length]); // Scroll on new message or progress update


  const handleSend = async () => {
    if ((!input.trim() && attachedFiles.length === 0) || !activeConversationId || isExecuting) return;

    // Build message content with file info
    let messageContent = input;
    let uploadedFileContext = '';

    // Upload attached files if any
    if (attachedFiles.length > 0) {
      setIsUploading(true);
      try {
        const formData = new FormData();
        attachedFiles.forEach(f => formData.append('files', f));
        formData.append('conversationId', serverConversationId || activeConversationId);

        const res = await fetch(`${API_BASE}/api/files/upload`, {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();

        if (data.success && data.files) {
          // Build context string for the agent
          const fileDescriptions = data.files.map((f: any) => {
            if (f.extractedText && f.type !== 'image') {
              return `[File: ${f.originalName} (${f.type})]\n${f.extractedText}`;
            }
            return `[Attached ${f.type}: ${f.originalName} (${formatFileSize(f.size)})]`;
          });
          uploadedFileContext = fileDescriptions.join('\n\n');

          // Show file names in user message
          const fileNames = attachedFiles.map(f => `📎 ${f.name}`).join(', ');
          messageContent = messageContent
            ? `${messageContent}\n\n${fileNames}`
            : fileNames;
        }
      } catch (err) {
        console.error('[Upload] Failed:', err);
      } finally {
        setIsUploading(false);
        setAttachedFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }

    const newMessage = {
      id: Date.now().toString(),
      role: 'user' as const,
      content: messageContent,
      timestamp: Date.now()
    };

    // Optimistic update
    addMessage(activeConversationId, newMessage);
    const userInput = input;
    setInput('');
    setAttachedFiles([]);

    // If agent was paused waiting for HITL reply, show confirmation + clear banner
    if (isHitlPending) {
      setIsHitlPending(false);
      addMessage(activeConversationId, {
        id: `hitl_resume_${Date.now()}`,
        role: 'system' as const,
        content: 'Answer received — resuming execution...',
        timestamp: Date.now(),
      });
    }

    setIsExecuting(true);
    setRespondingAgent(null); // clear previous agent badge when new message is sent

    // Safety timeout: auto-clear isExecuting after 90s to prevent stuck UI
    if (executionTimeoutRef.current) clearTimeout(executionTimeoutRef.current);
    executionTimeoutRef.current = setTimeout(() => {
      setIsExecuting(false);
      setExecutionProgress([]);
      console.warn('[Chat] Execution timeout — auto-cleared isExecuting after 90s');
    }, 90000);

    // F3: Update conversation title on first message
    const conv = conversations.get(activeConversationId);
    if (conv && (conv.title === 'New Session' || conv.title === 'New Chat' || conv.title === 'New Conversation') && conv.messages.length <= 1) {
      const title = userInput.length > 40 ? userInput.substring(0, 40) + '...' : userInput;
      updateConversationTitle(activeConversationId, title);
    }

    // Auto-prepend @slug when a specialist agent is pinned (unless user already typed @mention)
    const agentPrefix = (activeAgent && !userInput.startsWith('@'))
      ? `@${activeAgent.slug} `
      : '';
    const prefixedInput = agentPrefix + userInput;

    // Build content with file context for the agent
    const fullContent = uploadedFileContext
      ? `${prefixedInput}\n\n--- Attached Files ---\n${uploadedFileContext}`
      : prefixedInput;

    // Send via Socket.IO for streaming response
    const socket = getSocket();
    socket.emit('message:send', {
      content: fullContent,
      userId: 'default',
      mode: chatMode,
      conversationId: serverConversationId
    });
    // Response arrives via message:stream events (handled by websocket middleware)
  };

  const handleApprovePlan = (planId: string) => {
    // Plan status update handled via store/socket ideally, 
    // but for now simpler to just emit. 
    // The previous implementation updated local state. 
    // We should probably rely on the backend sending a plan update event.
    // For now, let's keep it simple:
    getSocket().emit('plan:approve', planId);
  };

  const handleCancelPlan = (planId: string) => {
    getSocket().emit('plan:cancel', planId);
  };

  const handleRunCode = (code: string) => {
    const language = code.includes('import') || code.includes('print') ? 'python' : 'javascript';
    getSocket().emit('code:run', { language, code });
  };

  // ... (existing imports)

  // ... (existing hook calls)

  return (
    <div className="flex h-full bg-background relative overflow-hidden">
      {/* Main Chat Column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg as any}
              onApprovePlan={handleApprovePlan}
              onCancelPlan={handleCancelPlan}
              onRunCode={handleRunCode}
            />
          ))}

          {/* Execution Progress Indicator */}
          {executionProgress.length > 0 && (
            <div className="bg-card border border-border rounded-xl p-4 space-y-3 max-w-[85%]">
              {/* Header: status dot + title + step counter + timer */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {isExecuting
                    ? <div className="w-2 h-2 bg-amber-400 rounded-full animate-pulse flex-shrink-0" />
                    : <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0" />
                  }
                  <span>{isExecuting ? 'Working on it...' : 'Done'}</span>
                </div>
                <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                  {executionProgress.filter(s => s.status === 'completed' || s.status === 'failed').length}
                  {' / '}
                  {executionProgress.length}
                  {' · '}
                  <ElapsedTimer running={isExecuting} />
                </span>
              </div>

              {/* Progress bar */}
              <div className="h-0.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{
                    width: `${(executionProgress.filter(s => s.status === 'completed' || s.status === 'failed').length / executionProgress.length) * 100}%`
                  }}
                />
              </div>

              {/* Step rows */}
              <div className="space-y-1.5">
                {executionProgress.map((step) => (
                  <div key={step.step} className="flex items-start gap-2.5">
                    {/* CSS dot — matches goal panel style */}
                    <div className="mt-[5px] flex-shrink-0">
                      {step.status === 'executing' && (
                        <div className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
                      )}
                      {step.status === 'completed' && (
                        <div className="w-2 h-2 bg-green-500 rounded-full" />
                      )}
                      {step.status === 'failed' && (
                        <div className="w-2 h-2 bg-red-500 rounded-full" />
                      )}
                      {step.status === 'pending' && (
                        <div className="w-2 h-2 rounded-full border border-muted-foreground/30" />
                      )}
                    </div>

                    {/* Description */}
                    <p className={`flex-1 min-w-0 text-sm leading-snug truncate ${
                      step.status === 'executing' ? 'text-foreground font-medium' :
                      step.status === 'completed' ? 'text-muted-foreground' :
                      step.status === 'failed'    ? 'text-red-500' :
                                                    'text-muted-foreground/50'
                    }`}>
                      {step.description}
                    </p>

                    {/* Tool badge — only for active/done steps */}
                    {step.status !== 'pending' && step.tool && (
                      <span className="flex-shrink-0 text-xs bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                        {step.tool}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Thinking indicator while waiting for first stream token */}
          {isExecuting && executionProgress.length === 0 && !streamingMessage && (
            <div className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
              <span>Thinking...</span>
            </div>
          )}

          {/* Responding agent badge (shows after execution_done or conversation:updated for named agent) */}
          {respondingAgent && !isExecuting && !streamingMessage && (
            <div className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-primary font-medium">
                🤖 @{respondingAgent}
              </span>
              <span>responded</span>
            </div>
          )}

          {/* Live streaming typing bubble */}
          {streamingMessage && (
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-full bg-primary/20 border border-border flex items-center justify-center text-xs font-bold text-primary shrink-0 mt-0.5">
                {respondingAgent ? respondingAgent.charAt(0).toUpperCase() : 'AI'}
              </div>
              <div className="flex-1 bg-card border border-border rounded-2xl rounded-tl-sm px-4 py-3 max-w-[85%]">
                {streamingMessage.content.startsWith('⚙️') ? (
                  <GoalExecutionLog content={streamingMessage.content} isDone={false} />
                ) : (
                  <p className="text-sm text-foreground whitespace-pre-wrap">{streamingMessage.content}</p>
                )}
                <div className="flex gap-0.5 mt-1.5">
                  <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 border-t border-border bg-card">
          {/* Mode Toggle */}
          <div className="max-w-3xl mx-auto flex items-center gap-1 mb-2">
            <span className="text-xs text-muted-foreground mr-1">Mode:</span>
            <button
              onClick={() => setChatMode('auto')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${chatMode === 'auto'
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent'
                }`}
              title="Auto-detect: system decides chat vs goal mode"
            >
              <Zap size={12} />
              Auto
            </button>
            <button
              onClick={() => setChatMode('chat')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${chatMode === 'chat'
                ? 'bg-blue-600 text-white'
                : 'bg-muted text-muted-foreground hover:bg-accent'
                }`}
              title="Chat mode: quick Q&A, no file creation"
            >
              <MessageSquare size={12} />
              Chat
            </button>
            <button
              onClick={() => setChatMode('goal')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${chatMode === 'goal'
                ? 'bg-orange-600 text-white'
                : 'bg-muted text-muted-foreground hover:bg-accent'
                }`}
              title="Goal mode: create files, execute tasks until done"
            >
              <Target size={12} />
              Goal
            </button>
          </div>

          <div className="max-w-3xl mx-auto relative">
            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => handleFileSelect(e.target.files)}
              accept=".txt,.md,.csv,.json,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.cpp,.c,.h,.go,.rs,.rb,.php,.sql,.yaml,.yml,.toml,.sh,.pdf,.png,.jpg,.jpeg,.gif,.webp,.svg,.mp3,.wav,.ogg,.webm,.mp4,.docx,.xlsx"
            />

            {/* HITL banner — agent paused, waiting for a free-text hint via chat.
                Structured HITL (provider/model/credential fields) is handled by the
                Goal panel on the right — this banner is suppressed for those cases. */}
            {isHitlPending && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg border border-amber-600/60 bg-amber-950/30 text-amber-300">
                <span className="text-base leading-none">⏸</span>
                <span className="text-xs font-medium flex-1">Agent is stuck — type a hint below to nudge it</span>
                <span className="text-[10px] text-amber-400/70">HITL</span>
              </div>
            )}

            {/* Active agent banner — shown when a specialist is pinned */}
            {activeAgent && (
              <div className="flex items-center gap-2 mb-2 px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/5">
                <div
                  className="w-5 h-5 rounded-md flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                  style={{ backgroundColor: activeAgent.avatarColor }}
                >
                  {activeAgent.name.charAt(0).toUpperCase()}
                </div>
                <Bot size={12} className="text-primary shrink-0" />
                <span className="text-xs font-medium text-primary flex-1">
                  Chatting with <strong>@{activeAgent.slug}</strong> · All messages routed to {activeAgent.name}
                </span>
                <button
                  onClick={() => setActiveAgent(null)}
                  className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                  title="Dismiss agent — return to normal chat"
                >
                  <X size={12} />
                </button>
              </div>
            )}

            {/* Attached files preview */}
            {attachedFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2 p-2 rounded-lg border border-input bg-muted/50">
                {attachedFiles.map((file, i) => (
                  <div
                    key={`${file.name}-${i}`}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-background border border-input text-xs"
                  >
                    {getFileIcon(file)}
                    <span className="max-w-[120px] truncate">{file.name}</span>
                    <span className="text-muted-foreground">({formatFileSize(file.size)})</span>
                    <button
                      onClick={() => removeFile(i)}
                      className="p-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* @mention autocomplete dropdown — also show "no profiles" hint */}
            {mentionQuery !== null && mentionProfiles.length === 0 && (
              <div className="absolute bottom-full mb-1 left-0 right-0 z-50 rounded-lg border border-border bg-popover shadow-lg px-3 py-2 text-xs text-muted-foreground">
                No agent profiles yet — open <span className="font-medium text-foreground">Agent Profiles</span> in the sidebar and click <span className="font-medium text-foreground">Starter Pack</span> to load 16 built-in agents.
              </div>
            )}
            {mentionQuery !== null && filteredMentions.length > 0 && (
              <div className="absolute bottom-full mb-1 left-0 right-0 z-50 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
                <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-b border-border/50 font-medium flex items-center justify-between">
                  <span>Agent profiles</span>
                  <span className="opacity-60">↑↓ navigate · Tab/↵ select · Esc close</span>
                </div>
                {filteredMentions.slice(0, 8).map((p, i) => (
                  <button
                    key={p.id}
                    onMouseDown={(e) => { e.preventDefault(); insertMention(p); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors ${i === mentionIndex ? 'bg-accent' : 'hover:bg-accent/50'}`}
                  >
                    {/* Avatar */}
                    <div
                      className="w-7 h-7 rounded-md flex items-center justify-center text-white text-[11px] font-bold shrink-0"
                      style={{ backgroundColor: p.avatarColor }}
                    >
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                    {/* Main info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-foreground">@{p.slug}</span>
                        {p.agentType && p.agentType !== 'research' && (
                          <span
                            className="text-[9px] px-1.5 py-0.5 rounded-full font-medium text-white shrink-0"
                            style={{ backgroundColor: AGENT_TYPE_COLORS[p.agentType] ?? '#6366f1' }}
                          >
                            {p.agentType}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">{p.role}</div>
                    </div>
                    {/* Iteration hint */}
                    {p.maxIterations && (
                      <span className="text-[10px] text-muted-foreground shrink-0">{p.maxIterations} steps</span>
                    )}
                  </button>
                ))}
                {mentionQuery.length > 0 && filteredMentions.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted-foreground">No agents match &quot;{mentionQuery}&quot;</div>
                )}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onFocus={fetchMentionProfiles}
              onKeyDown={(e) => {
                // Handle mention dropdown navigation
                if (mentionQuery !== null && filteredMentions.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex(i => Math.min(i + 1, filteredMentions.length - 1)); return; }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex(i => Math.max(i - 1, 0)); return; }
                  if (e.key === 'Tab' || (e.key === 'Enter' && filteredMentions.length > 0 && mentionQuery !== null)) {
                    e.preventDefault(); insertMention(filteredMentions[mentionIndex]); return;
                  }
                  if (e.key === 'Escape') { setMentionQuery(null); return; }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleFileSelect(e.dataTransfer.files);
              }}
              placeholder={
                activeAgent
                  ? `Message @${activeAgent.slug} (${activeAgent.name})…`
                  : chatMode === 'goal'
                    ? 'Describe what you want to create or accomplish...'
                    : chatMode === 'chat'
                      ? 'Ask a question... or type @ to mention a specialist agent'
                      : 'Type your message… or @ to mention an agent'
              }
              className="w-full min-h-[50px] max-h-[200px] p-3 pr-24 rounded-lg border border-input bg-background resize-none focus:outline-none focus:ring-1 focus:ring-ring text-sm"
            />

            {/* Action Buttons */}
            <div className="absolute right-2 bottom-2.5 flex items-center space-x-1">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className={`p-1.5 rounded-md transition-colors ${isUploading
                  ? 'text-yellow-500 animate-pulse cursor-wait'
                  : attachedFiles.length > 0
                    ? 'text-primary bg-primary/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                title={isUploading ? 'Uploading...' : `Attach Files${attachedFiles.length > 0 ? ` (${attachedFiles.length})` : ''}`}
              >
                <Paperclip size={16} />
              </button>
              <button
                onClick={handleVoiceToggle}
                disabled={isTranscribing}
                className={`p-1.5 rounded-md transition-colors ${isRecording
                  ? 'bg-red-500 text-white animate-pulse'
                  : isTranscribing
                    ? 'bg-yellow-500/20 text-yellow-500 cursor-wait'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                title={isRecording ? 'Stop Recording' : isTranscribing ? 'Transcribing...' : 'Voice Input'}
              >
                {isRecording ? <MicOff size={16} /> : <Mic size={16} />}
              </button>
              {isExecuting ? (
                <button
                  onClick={handleStop}
                  className="p-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors"
                  title="Stop execution"
                >
                  <Square size={16} />
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={isExecuting}
                  className="p-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <ArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between mt-2 px-1">
            <span className="text-[10px] text-muted-foreground">
              Local AI can make mistakes. Verify critical code.
            </span>

            {/* Approval mode badge */}
            <div className="relative">
              <button
                onClick={() => setApprovalPopoverOpen(v => !v)}
                className="flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border border-border hover:bg-accent transition-colors"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${approvalMode === 'none' ? 'bg-green-500' : approvalMode === 'all' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                <span className="text-muted-foreground">
                  {approvalMode === 'none' ? 'Autonomous' : approvalMode === 'all' ? 'Manual' : 'Script Review'}
                </span>
                <ChevronDown size={9} className="text-muted-foreground" />
              </button>

              {approvalPopoverOpen && (
                <div className="absolute bottom-full right-0 mb-1 w-52 bg-card border border-border rounded-lg shadow-lg p-2 z-50">
                  <p className="text-[10px] text-muted-foreground font-medium mb-2 px-1">Approval Mode</p>
                  {([
                    { value: 'none', dot: 'bg-green-500', label: 'Autonomous', desc: 'No pauses' },
                    { value: 'script', dot: 'bg-yellow-500', label: 'Script Review', desc: 'Review scripts' },
                    { value: 'all', dot: 'bg-red-500', label: 'Manual', desc: 'Approve every action' },
                  ] as const).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleApprovalModeChange(opt.value)}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-xs hover:bg-accent transition-colors ${approvalMode === opt.value ? 'bg-accent font-medium' : ''}`}
                    >
                      <span className={`h-2 w-2 rounded-full flex-shrink-0 ${opt.dot}`} />
                      <span>{opt.label}</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">{opt.desc}</span>
                    </button>
                  ))}
                  <p className="text-[10px] text-muted-foreground mt-2 px-1 border-t border-border pt-2">
                    Or type <code className="bg-muted px-0.5 rounded">/auto on</code> · <code className="bg-muted px-0.5 rounded">/auto off</code>
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
