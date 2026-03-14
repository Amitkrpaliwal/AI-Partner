import { API_BASE } from '@/lib/api';
import { Folder, FolderOpen, FileCode, Clock, Plus, LayoutDashboard, MessageSquare, Brain, Zap, Plug, Settings as SettingsIcon, Database, Users, Network, Trash2, Package, DollarSign, Radio, GraduationCap, ScrollText, ChevronDown, ChevronRight, Download, Link2, RefreshCw, FolderPlus, Edit2, Copy, Move, File, Heart, Upload, Shield, X, Eye } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getSocket } from '@/lib/socket';
import { useStore } from '@/store';

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Recursive file traversal for DnD
async function traverseFileTree(item: any, path = ''): Promise<{ file: File, path: string }[]> {
  if (item.isFile) {
    return new Promise(resolve => {
      item.file((file: File) => resolve([{ file, path: path + file.name }]));
    });
  } else if (item.isDirectory) {
    const dirReader = item.createReader();
    return new Promise(resolve => {
      const entries: any[] = [];
      const read = () => {
        dirReader.readEntries(async (results: any[]) => {
          if (!results.length) {
            const promises = entries.map(entry => traverseFileTree(entry, path + item.name + '/'));
            const recursiveResults = await Promise.all(promises);
            resolve(recursiveResults.flat());
          } else {
            entries.push(...results);
            read();
          }
        });
      };
      read();
    });
  }
  return [];
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number | null;
  modified: string;
  children?: FileEntry[];
}

// ─── Sidebar ───────────────────────────────────────────────────────────────────

export function Sidebar() {
  const { currentView, setView, loadConversationFromServer, createConversation, deleteConversation, oodaLogs, clearOODALogs } = useStore();
  const [history, setHistory] = useState<any[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [unreadConvIds, setUnreadConvIds] = useState<Set<string>>(new Set());
  const activeConvIdRef = useRef<string | null>(null);
  // Keep ref in sync so socket handlers (closed over old state) always see current value
  useEffect(() => { activeConvIdRef.current = activeConvId; }, [activeConvId]);
  const [logsExpanded, setLogsExpanded] = useState(true);

  const [workspacePath, setWorkspacePath] = useState('');
  const [isWorkspaceSet, setIsWorkspaceSet] = useState(false);
  const [treeEntries, setTreeEntries] = useState<FileEntry[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  // Incremented on each manual refresh to force FileTreeNode children re-sync
  const [refreshToken, setRefreshToken] = useState(0);

  // ─── File preview modal ────────────────────────────────────────────────────
  const [previewFile, setPreviewFile] = useState<{ path: string; name: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Listen for file-preview events dispatched from MessageBubble (chat file chips).
  // Inline the open logic here to avoid stale-closure from the later handleFileClick definition.
  useEffect(() => {
    const IMAGE_EXTS_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
    const handler = async (e: Event) => {
      const { path, name } = (e as CustomEvent).detail as { path: string; name: string };
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      if (IMAGE_EXTS_SET.has(ext)) {
        setPreviewFile({ path, name, content: '__image__' });
        return;
      }
      setPreviewLoading(true);
      setPreviewFile({ path, name, content: '' });
      try {
        const res = await fetch(`${API_BASE}/api/workspace/content?path=${encodeURIComponent(path)}`);
        const data = await res.json();
        setPreviewFile({ path, name, content: data.content ?? data.error ?? 'Could not load file.' });
      } catch {
        setPreviewFile({ path, name, content: 'Failed to fetch file content.' });
      } finally {
        setPreviewLoading(false);
      }
    };
    window.addEventListener('file-preview', handler);
    return () => window.removeEventListener('file-preview', handler);
  }, []);

  // ─── Load workspace + file tree via REST ──────────────────────────────────

  const fetchTree = useCallback(async (subPath: string = '', forceRefreshToken?: number) => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      // cache: 'no-store' prevents the browser from returning a stale cached response
      const url = `${API_BASE}/api/workspace/files?path=${encodeURIComponent(subPath)}&depth=2&_t=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        setTreeEntries(data.entries);
        // Bump refreshToken so FileTreeNode useEffect re-syncs stale children state
        if (forceRefreshToken !== undefined) {
          setRefreshToken(forceRefreshToken);
        }
      } else {
        throw new Error(data.error || 'Unknown error loading files');
      }
    } catch (e: any) {
      console.error('Failed to load file tree:', e);
      setTreeError(e.message || 'Failed to load files');
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    const socket = getSocket();

    // Fetch history
    fetch(`${API_BASE}/api/conversations`)
      .then(res => res.json())
      .then(data => setHistory(data.conversations || []))
      .catch(console.error);

    // Auto-load workspace if saved (no initialized check — path is enough)
    fetch(`${API_BASE}/api/workspace`)
      .then(res => res.json())
      .then(data => {
        if (data.path) {
          setWorkspacePath(data.path);
          setIsWorkspaceSet(true);
          fetchTree();
        }
      })
      .catch(console.error);

    // Debounced refresh — collapses rapid socket events (agent writing many files)
    // into a single fetch instead of one per file, preventing rate-limit hits.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { fetchTree(); }, 1500);
    };

    // Socket still used to trigger refresh after agent file operations
    socket.on('file:list', debouncedFetch);
    // Auto-refresh file tree when a goal completes or fails (files were created)
    socket.on('goal:completed', debouncedFetch);
    socket.on('goal:failed', debouncedFetch);
    // Dedicated workspace refresh signal (belt-and-suspenders alongside goal events)
    socket.on('workspace:refresh', debouncedFetch);

    const reloadHistory = () => {
      fetch(`${API_BASE}/api/conversations`)
        .then(res => res.json())
        .then(data => setHistory(data.conversations || []))
        .catch(console.error);
    };

    // When an external provider (Telegram, Discord) updates a conversation:
    // 1. Reload the sidebar list so it appears at the top.
    // 2. If user isn't currently viewing it, add an unread badge (green dot).
    // 3. Auto-navigate to it if no conversation is currently open.
    const handleConvUpdated = (data: { conversationId?: string }) => {
      reloadHistory();
      const convId = data?.conversationId;
      if (!convId) return;
      if (activeConvIdRef.current !== convId) {
        setUnreadConvIds(prev => new Set(prev).add(convId));
        // Auto-navigate only when user has no active conversation open
        if (!activeConvIdRef.current) {
          setActiveConvId(convId);
          activeConvIdRef.current = convId;
          setView('chat');
          fetch(`${API_BASE}/api/conversations/${convId}/messages`)
            .then(r => r.json())
            .then(d => {
              const msgs = d.messages || [];
              const title = msgs.length > 0 ? (msgs[0].content || '').substring(0, 50) : convId;
              loadConversationFromServer(convId, title);
            })
            .catch(() => {});
        }
      }
    };

    // Refresh conversation list when messages are received from external providers (Telegram, Discord, etc).
    // 'conversation:updated' fires AFTER chat() completes and DB is written — correct timing.
    // 'message:received' fires before processing — keep for activity feed compat but don't reload here.
    socket.on('conversation:updated', handleConvUpdated);
    socket.on('chat:execution_done', reloadHistory);
    // Reload when any streamed message is committed (covers goal mode, simple chat, and OODA paths)
    const handleStreamDone = (data: any) => { if (data?.done) reloadHistory(); };
    socket.on('message:stream', handleStreamDone);
    // Reload immediately when a new conversation is created (goal start) so it appears in sidebar
    const handleConvId = () => reloadHistory();
    socket.on('conversation:id', handleConvId);

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      socket.off('file:list', debouncedFetch);
      socket.off('goal:completed', debouncedFetch);
      socket.off('goal:failed', debouncedFetch);
      socket.off('workspace:refresh', debouncedFetch);
      socket.off('conversation:updated', handleConvUpdated);
      socket.off('chat:execution_done', reloadHistory);
      socket.off('message:stream', handleStreamDone);
      socket.off('conversation:id', handleConvId);
    };
  }, [fetchTree]);

  // Refresh history when switching to chat view
  useEffect(() => {
    if (currentView === 'chat') {
      fetch(`${API_BASE}/api/conversations`)
        .then(res => res.json())
        .then(data => setHistory(data.conversations || []))
        .catch(console.error);
    }
  }, [currentView]);

  // ─── Drag & Drop Upload ───────────────────────────────────────────────────

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (!isWorkspaceSet) {
      alert('Please set a workspace first.');
      return;
    }

    const items = e.dataTransfer.items;
    if (!items) return;

    setUploadStatus('Scanning files...');
    const fileList: { file: File, path: string }[] = [];

    // Traverse all dropped items
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry?.() || (item as any).getAsEntry?.();
        if (entry) entries.push(entry);
      }
    }

    for (const entry of entries) {
      const results = await traverseFileTree(entry);
      fileList.push(...results);
    }

    if (fileList.length === 0) {
      setUploadStatus(null);
      return;
    }

    setUploadStatus(`Uploading ${fileList.length} files...`);

    // Upload files sequentially to prevent overwhelming the server/network
    // or in small batches
    let successCount = 0;
    const batchSize = 5;

    for (let i = 0; i < fileList.length; i += batchSize) {
      const batch = fileList.slice(i, i + batchSize);
      await Promise.all(batch.map(async ({ file, path }) => {
        const formData = new FormData();
        formData.append('file', file);
        // Upload to root workspace (empty path prefix) + relative file path
        formData.append('path', '');
        formData.append('filepath', path); // Custom field for relative structure

        try {
          const res = await fetch(`${API_BASE}/api/workspace/upload`, {
            method: 'POST',
            body: formData,
          });
          if (res.ok) successCount++;
        } catch (e) {
          console.error(`Failed to upload ${path}`, e);
        }
      }));
      setUploadStatus(`Uploaded ${Math.min(i + batchSize, fileList.length)}/${fileList.length}...`);
    }

    setUploadStatus(null);
    fetchTree(); // Refresh
  };

  // ─── File operations ──────────────────────────────────────────────────────

  const handleDelete = async (entry: FileEntry) => {
    const label = entry.type === 'directory' ? `folder "${entry.name}" and all its contents` : `"${entry.name}"`;
    if (!confirm(`Delete ${label}?`)) return;
    try {
      const recursive = entry.type === 'directory' ? '&recursive=true' : '';
      await fetch(`${API_BASE}/api/workspace/file?path=${encodeURIComponent(entry.path)}${recursive}`, { method: 'DELETE' });
      fetchTree();
    } catch (e) { alert('Delete failed'); }
  };

  const handleRename = async (entry: FileEntry) => {
    const newName = window.prompt(`Rename "${entry.name}" to:`, entry.name);
    if (!newName || newName === entry.name) return;
    const dir = entry.path.includes('/') ? entry.path.substring(0, entry.path.lastIndexOf('/') + 1) : '';
    const to = dir + newName;
    try {
      const res = await fetch(`${API_BASE}/api/workspace/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: entry.path, to }),
      });
      const data = await res.json();
      if (data.success) fetchTree();
      else alert(data.error || 'Rename failed');
    } catch (e) { alert('Rename failed'); }
  };

  const handleCopy = async (entry: FileEntry) => {
    const ext = entry.name.includes('.') ? '' : '';
    const suggest = entry.name.replace(/(\.[^.]+)?$/, '_copy$1');
    const newName = window.prompt(`Copy "${entry.name}" as:`, suggest);
    if (!newName) return;
    const dir = entry.path.includes('/') ? entry.path.substring(0, entry.path.lastIndexOf('/') + 1) : '';
    try {
      const res = await fetch(`${API_BASE}/api/workspace/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: entry.path, to: dir + newName }),
      });
      const data = await res.json();
      if (data.success) fetchTree();
      else alert(data.error || 'Copy failed');
    } catch (e) { alert('Copy failed'); }
  };

  const handleDownload = (entry: FileEntry) => {
    const a = document.createElement('a');
    a.href = `${API_BASE}/api/workspace/download?path=${encodeURIComponent(entry.path)}`;
    a.download = entry.name;
    a.click();
  };

  const handleNewFolder = async () => {
    const name = window.prompt('New folder name:');
    if (!name) return;
    try {
      await fetch(`${API_BASE}/api/workspace/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: name }),
      });
      fetchTree();
    } catch (e) { alert('Failed to create folder'); }
  };

  const handleNewFile = () => {
    const filename = window.prompt('New file name (e.g. notes.txt):');
    if (filename) {
      getSocket().emit('message:send', { content: `Create an empty file named "${filename}" in the workspace root directory.` });
      setTimeout(() => fetchTree(), 2000);
    }
  };

  const handleFileClick = async (entry: FileEntry) => {
    const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTS.has(ext)) {
      // Images render via URL directly — no content fetch needed
      setPreviewFile({ path: entry.path, name: entry.name, content: '__image__' });
      return;
    }
    setPreviewLoading(true);
    setPreviewFile({ path: entry.path, name: entry.name, content: '' });
    try {
      const res = await fetch(`${API_BASE}/api/workspace/content?path=${encodeURIComponent(entry.path)}`);
      const data = await res.json();
      setPreviewFile({ path: entry.path, name: entry.name, content: data.content ?? data.error ?? 'Could not load file.' });
    } catch {
      setPreviewFile({ path: entry.path, name: entry.name, content: 'Failed to fetch file content.' });
    } finally {
      setPreviewLoading(false);
    }
  };

  // ─── History ──────────────────────────────────────────────────────────────

  const handleHistoryClick = async (id: string, title: string) => {
    setActiveConvId(id);
    setUnreadConvIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setView('chat');
    await loadConversationFromServer(id, title);
  };

  const refreshHistory = () => {
    fetch(`${API_BASE}/api/conversations`)
      .then(res => res.json())
      .then(data => setHistory(data.conversations || []))
      .catch(console.error);
  };

  const handleDeleteConversation = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this conversation?')) return;
    try {
      await fetch(`${API_BASE}/api/conversations/${id}`, { method: 'DELETE' });
      deleteConversation(`server_${id}`);
      if (activeConvId === id) setActiveConvId(null);
      refreshHistory();
    } catch (e) { console.error('Failed to delete conversation:', e); }
  };

  const handleNewChat = () => {
    createConversation('New Chat');
    setView('chat');
  };

  // ─── Nav item component ───────────────────────────────────────────────────

  const NavItem = ({ view, label, icon: Icon }: { view: string, label: string, icon: any }) => (
    <div
      onClick={() => setView(view as any)}
      className={cn(
        "px-3 py-2 flex items-center cursor-pointer transition-colors text-sm font-medium",
        currentView === view ? "bg-accent text-accent-foreground border-r-2 border-primary" : "hover:bg-accent/50 text-muted-foreground"
      )}
    >
      <Icon size={16} className="mr-2" />
      {label}
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────────

  // ─── File preview helpers ─────────────────────────────────────────────────
  const getFileExt = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
  const isMarkdown = (name: string) => ['md', 'markdown'].includes(getFileExt(name));
  const isJson = (name: string) => getFileExt(name) === 'json';
  const isCode = (name: string) => ['ts', 'tsx', 'js', 'jsx', 'py', 'sh', 'yaml', 'yml', 'toml', 'css', 'html'].includes(getFileExt(name));

  const formatJson = (raw: string) => {
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  };

  return (
    <>
    {/* ─── File Preview Modal ────────────────────────────────────────────── */}
    {previewFile && (
      <div
        className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
        onClick={() => setPreviewFile(null)}
      >
        <div
          className="bg-card border border-border rounded-xl shadow-2xl flex flex-col w-full max-w-3xl max-h-[85vh]"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
            <Eye size={16} className="text-primary shrink-0" />
            <span className="text-sm font-medium text-foreground truncate flex-1" title={previewFile.path}>
              {previewFile.name}
            </span>
            <span className="text-xs text-muted-foreground truncate max-w-xs hidden sm:block">{previewFile.path}</span>
            <a
              href={`${API_BASE}/api/workspace/download?path=${encodeURIComponent(previewFile.path)}`}
              download={previewFile.name}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
              title="Download"
              onClick={e => e.stopPropagation()}
            >
              <Download size={14} />
            </a>
            <button
              onClick={() => setPreviewFile(null)}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            >
              <X size={14} />
            </button>
          </div>

          {/* Content */}
          <div className="overflow-y-auto flex-1 p-4 text-sm">
            {previewLoading ? (
              <div className="text-muted-foreground animate-pulse">Loading…</div>
            ) : previewFile.content === '__image__' ? (
              <div className="flex items-center justify-center">
                <img
                  src={`${API_BASE}/api/workspace/download?path=${encodeURIComponent(previewFile.path)}`}
                  alt={previewFile.name}
                  className="max-w-full rounded border border-border"
                />
              </div>
            ) : isMarkdown(previewFile.name) ? (
              <div className="prose prose-sm prose-invert max-w-none">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    h1: ({ children }) => <h1 className="text-lg font-bold mt-3 mb-1">{children}</h1>,
                    h2: ({ children }) => <h2 className="text-base font-bold mt-3 mb-1">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-0.5">{children}</h3>,
                    p: ({ children }) => <p className="mb-2 leading-relaxed text-foreground/90">{children}</p>,
                    strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                    ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-2 ml-2">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-2 ml-2">{children}</ol>,
                    li: ({ children }) => <li className="text-sm text-foreground/90">{children}</li>,
                    table: ({ children }) => (
                      <div className="overflow-x-auto my-3">
                        <table className="w-full text-xs border-collapse border border-border rounded">{children}</table>
                      </div>
                    ),
                    thead: ({ children }) => <thead className="bg-accent/50">{children}</thead>,
                    th: ({ children }) => <th className="px-3 py-2 text-left font-semibold border border-border">{children}</th>,
                    td: ({ children }) => <td className="px-3 py-2 border border-border">{children}</td>,
                    code: ({ children, className }) => {
                      const isBlock = className?.includes('language-');
                      return isBlock
                        ? <code className={cn("block bg-black/30 rounded p-3 text-xs font-mono overflow-x-auto my-2 whitespace-pre", className)}>{children}</code>
                        : <code className="bg-black/30 text-blue-300 px-1 py-0.5 rounded text-xs font-mono">{children}</code>;
                    },
                    pre: ({ children }) => <>{children}</>,
                  }}
                >
                  {previewFile.content}
                </ReactMarkdown>
              </div>
            ) : isJson(previewFile.name) ? (
              <pre className="text-xs font-mono text-green-300 whitespace-pre-wrap break-all bg-black/20 rounded p-3 overflow-x-auto">
                {formatJson(previewFile.content)}
              </pre>
            ) : isCode(previewFile.name) ? (
              <pre className="text-xs font-mono text-foreground/90 whitespace-pre-wrap bg-black/20 rounded p-3 overflow-x-auto">
                {previewFile.content}
              </pre>
            ) : (
              <pre className="text-xs font-mono text-foreground/90 whitespace-pre-wrap">
                {previewFile.content}
              </pre>
            )}
          </div>
        </div>
      </div>
    )}

    <div className="w-96 border-r border-border bg-card flex flex-col h-full font-sans">

      {/* 1. Main Navigation */}
      <div className="flex flex-col py-2 border-b border-border">
        <NavItem view="dashboard" label="Dashboard" icon={LayoutDashboard} />
        <NavItem view="chat" label="Conversations" icon={MessageSquare} />
        <NavItem view="memory" label="Memory Inspector" icon={Brain} />
        <NavItem view="tasks" label="Task Scheduler" icon={Zap} />
        <NavItem view="skills" label="Skills Manager" icon={Plug} />
        <NavItem view="knowledge" label="Knowledge Base" icon={Database} />
        <NavItem view="files" label="Generated Files" icon={Download} />
        <NavItem view="agents" label="Agent Pool" icon={Users} />
        <NavItem view="routing" label="Model Routing" icon={Network} />
        <NavItem view="toolMarketplace" label="Tool Marketplace" icon={Package} />
        <NavItem view="learnedSkills" label="Learned Skills" icon={GraduationCap} />
        <NavItem view="usage" label="Usage & Cost" icon={DollarSign} />
        <NavItem view="messaging" label="Messaging" icon={Radio} />
        <NavItem view="proactive" label="Proactive" icon={Heart} />
        <NavItem view="capabilities" label="Capabilities" icon={Shield} />
        <NavItem view="integrations" label="Integrations" icon={Link2} />
        <NavItem view="setup" label="Re-run Setup" icon={Zap} />
        <NavItem view="settings" label="Settings" icon={SettingsIcon} />
      </div>

      {/* 2. Workspace Header */}
      <div className="p-3 border-b border-border flex items-center justify-between bg-muted/20">
        <div className="font-semibold text-xs flex items-center text-muted-foreground tracking-wider">
          <Folder size={14} className="mr-2" />
          WORKSPACE
        </div>
        <div className="flex space-x-1">
          {isWorkspaceSet && (
            <>
              <button
                onClick={() => {
                  const next = refreshToken + 1;
                  setRefreshToken(next);
                  fetchTree('', next);
                }}
                className="p-1 hover:bg-accent rounded"
                title="Refresh files"
                disabled={treeLoading}
              >
                <RefreshCw size={13} className={treeLoading ? 'animate-spin text-primary' : ''} />
              </button>
              <button onClick={handleNewFolder} className="p-1 hover:bg-accent rounded" title="New Folder">
                <FolderPlus size={13} />
              </button>
              <button onClick={handleNewFile} className="p-1 hover:bg-accent rounded" title="New File">
                <Plus size={13} />
              </button>
              <button
                onClick={() => setIsWorkspaceSet(false)}
                className="p-1 hover:bg-accent rounded text-muted-foreground"
                title="Change Workspace"
              >
                <Edit2 size={11} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* 3. Workspace Selector (shown only when changing) */}
      {!isWorkspaceSet && (
        <div className="p-2 border-b border-border bg-yellow-500/10">
          <div className="text-xs text-muted-foreground mb-1">Set Root Directory</div>
          <div className="flex space-x-1">
            <input
              className="flex-1 bg-background border border-input rounded px-2 py-1 text-xs"
              placeholder="e.g. D:\Projects\MyApp"
              value={workspacePath}
              onChange={(e) => setWorkspacePath(e.target.value)}
            />
            <button
              className="bg-secondary text-secondary-foreground text-xs px-2 rounded hover:bg-secondary/80"
              title="Browse for folder"
              onClick={() => {
                fetch(`${API_BASE}/api/system/browse`)
                  .then(res => res.json())
                  .then(data => { if (data.path) setWorkspacePath(data.path); })
                  .catch(console.error);
              }}
            >
              📁
            </button>
            <button
              className="bg-primary text-primary-foreground text-xs px-2 rounded hover:bg-primary/90"
              onClick={async () => {
                if (!workspacePath.trim()) return;
                try {
                  const res = await fetch(`${API_BASE}/api/workspace`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: workspacePath })
                  });
                  const data = await res.json();
                  if (data.success) {
                    setIsWorkspaceSet(true);
                    fetchTree();
                  } else {
                    alert('Failed to set workspace: ' + (data.error || 'Unknown error'));
                  }
                } catch (e) {
                  alert('Error setting workspace');
                }
              }}
            >
              Set
            </button>
          </div>
        </div>
      )}

      {/* 4. File Tree with Drag & Drop */}
      <div
        className={cn(
          "flex-1 overflow-y-auto relative transition-colors",
          isDragging ? "bg-primary/10" : ""
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm z-10 pointer-events-none">
            <div className="bg-card p-4 rounded-lg shadow-lg border border-primary flex flex-col items-center animate-in fade-in zoom-in-95">
              <Upload size={32} className="text-primary mb-2" />
              <div className="font-semibold text-sm">Drop files to copy</div>
              <div className="text-xs text-muted-foreground">Recursive folders supported</div>
            </div>
          </div>
        )}

        {uploadStatus && (
          <div className="absolute bottom-4 left-4 right-4 bg-primary text-primary-foreground text-xs py-2 px-3 rounded shadow-lg z-20 animate-in slide-in-from-bottom-2">
            {uploadStatus}
          </div>
        )}

        {isWorkspaceSet && (
          <div className="px-2 pt-2">
            {treeLoading && treeEntries.length === 0 && (
              <div className="text-xs text-muted-foreground px-2 py-2">Loading files...</div>
            )}
            {treeError && (
              <div className="text-xs text-destructive px-2 py-2 flex items-center gap-1">
                <span>⚠</span> {treeError}
              </div>
            )}
            {!treeLoading && !treeError && treeEntries.length === 0 && (
              <div className="text-xs text-muted-foreground px-2 py-2">Workspace is empty. Drop files here to upload.</div>
            )}
            <div className="space-y-0.5">
              {treeEntries.map(entry => (
                <FileTreeNode
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  onFileClick={handleFileClick}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onCopy={handleCopy}
                  onDownload={handleDownload}
                  onRefresh={fetchTree}
                  refreshToken={refreshToken}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 5. Agent Logs */}
      <div className="border-t border-border flex flex-col" style={{ maxHeight: logsExpanded ? '30%' : 'auto' }}>
        <div
          className="p-3 border-b border-border font-semibold text-xs flex items-center justify-between bg-muted/20 text-muted-foreground tracking-wider cursor-pointer select-none"
          onClick={() => setLogsExpanded(!logsExpanded)}
        >
          <div className="flex items-center">
            {logsExpanded ? <ChevronDown size={14} className="mr-1" /> : <ChevronRight size={14} className="mr-1" />}
            <ScrollText size={14} className="mr-2" />
            AGENT LOGS
            {oodaLogs.length > 0 && (
              <span className="ml-2 bg-primary/20 text-primary text-[10px] px-1.5 py-0.5 rounded-full font-mono">
                {oodaLogs.length}
              </span>
            )}
          </div>
          {oodaLogs.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); clearOODALogs(); }}
              className="p-1 hover:bg-accent rounded text-muted-foreground hover:text-foreground"
              title="Clear logs"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        {logsExpanded && (
          <div className="overflow-y-auto flex-1 p-1 bg-accent/5 font-mono text-[10px]">
            {oodaLogs.length === 0 ? (
              <div className="text-muted-foreground text-center py-3">No agent activity yet</div>
            ) : (
              oodaLogs.slice(0, 50).map((log, i) => {
                const phaseColors: Record<string, string> = {
                  OBSERVE: 'text-blue-400',
                  ORIENT: 'text-cyan-400',
                  DECIDE: 'text-yellow-400',
                  ACT: 'text-green-400',
                  REFLECT: 'text-purple-400',
                };
                const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                return (
                  <div key={i} className="flex gap-1 px-1.5 py-0.5 hover:bg-accent/30 rounded leading-tight">
                    <span className="text-muted-foreground shrink-0">{time}</span>
                    <span className={cn('shrink-0 font-bold', phaseColors[log.phase] || 'text-muted-foreground')}>
                      {log.phase.slice(0, 3)}
                    </span>
                    <span className="text-foreground/80 truncate" title={log.message}>
                      {log.message}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* 6. History Section */}
      <div className="border-t border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border font-semibold text-xs flex items-center justify-between bg-muted/20 text-muted-foreground tracking-wider">
          <div className="flex items-center">
            <Clock size={14} className="mr-2" />
            RECENT CHAT
          </div>
          <button
            onClick={handleNewChat}
            className="p-1 hover:bg-accent rounded text-primary"
            title="New Chat"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="p-2 overflow-y-auto bg-accent/5 max-h-48">
          {history.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-4">No history yet</div>
          ) : (
            history.map((conv: any) => (
              <div
                key={conv.id}
                onClick={() => handleHistoryClick(conv.id, conv.title || 'Untitled Session')}
                className={cn(
                  "flex items-center justify-between p-2 rounded cursor-pointer text-sm mb-1 transition-colors group",
                  activeConvId === conv.id ? "bg-accent text-accent-foreground" : "hover:bg-accent/50 text-muted-foreground"
                )}
              >
                <span className="truncate flex-1 flex items-center gap-1">
                  {unreadConvIds.has(conv.id) && (
                    <span className="inline-block w-2 h-2 rounded-full bg-green-400 flex-shrink-0" title="New message" />
                  )}
                  {conv.title || 'Untitled Session'}
                </span>
                <button
                  onClick={(e) => handleDeleteConversation(e, conv.id)}
                  className="p-1 hover:bg-destructive/20 rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  title="Delete conversation"
                >
                  <Trash2 size={12} className="text-destructive" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
    </>
  );
}

// ─── File Tree Node ────────────────────────────────────────────────────────────

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  onFileClick: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onCopy: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
  onRefresh: () => void;
  refreshToken?: number;
}

function FileTreeNode({ entry, depth, onFileClick, onDelete, onRename, onCopy, onDownload, onRefresh, refreshToken }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [children, setChildren] = useState<FileEntry[] | null>(entry.children || null);
  const [loading, setLoading] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const prevRefreshToken = useRef(refreshToken);

  // When the parent refreshes the tree, re-sync children with the freshly fetched entry.children.
  // entry.children is populated by the depth-2 API response for directories within fetch depth.
  // For deeper directories (entry.children === undefined), we keep any lazily-loaded state.
  useEffect(() => {
    if (refreshToken !== prevRefreshToken.current) {
      prevRefreshToken.current = refreshToken;
      // Only reset if parent provided fresh children data for this entry
      if (entry.children !== undefined) {
        setChildren(entry.children);
      } else if (expanded) {
        // Directory is expanded but beyond fetch depth — re-fetch it lazily
        setChildren(null);
        setLoading(true);
        fetch(`${API_BASE}/api/workspace/files?path=${encodeURIComponent(entry.path)}&depth=2&_t=${Date.now()}`, { cache: 'no-store' })
          .then(r => r.json())
          .then(data => { if (data.success) setChildren(data.entries); })
          .catch(() => {})
          .finally(() => setLoading(false));
      }
    }
  }, [refreshToken, entry.children, entry.path, expanded]);

  const isDir = entry.type === 'directory';
  const indent = depth * 12;

  const toggleExpand = async () => {
    if (!isDir) return;
    const next = !expanded;
    setExpanded(next);
    if (next && !children) {
      setLoading(true);
      try {
        const res = await fetch(
          `${API_BASE}/api/workspace/files?path=${encodeURIComponent(entry.path)}&depth=2&_t=${Date.now()}`,
          { cache: 'no-store' }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.success) setChildren(data.entries);
      } catch { /* ignore */ } finally {
        setLoading(false);
      }
    }
  };

  const fileSize = (bytes: number | null) => {
    if (bytes === null) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <div>
      <div
        className="flex items-center py-1 px-1 hover:bg-accent/50 rounded-sm transition-colors group cursor-pointer select-none"
        style={{ paddingLeft: `${indent + 4}px` }}
        onMouseEnter={() => setActionsVisible(true)}
        onMouseLeave={() => setActionsVisible(false)}
        onClick={() => isDir ? toggleExpand() : onFileClick(entry)}
      >
        {/* Expand toggle for directories */}
        <span className="shrink-0 w-4 mr-0.5 flex items-center justify-center text-muted-foreground">
          {isDir ? (
            loading ? (
              <RefreshCw size={11} className="animate-spin" />
            ) : expanded ? (
              <ChevronDown size={12} onClick={(e) => { e.stopPropagation(); toggleExpand(); }} />
            ) : (
              <ChevronRight size={12} onClick={(e) => { e.stopPropagation(); toggleExpand(); }} />
            )
          ) : null}
        </span>

        {/* Icon */}
        <span className="shrink-0 mr-1.5">
          {isDir
            ? expanded ? <FolderOpen size={14} className="text-yellow-500" /> : <Folder size={14} className="text-yellow-500" />
            : <FileIcon name={entry.name} />
          }
        </span>

        {/* Name */}
        <span className="text-xs truncate flex-1 text-foreground/80 group-hover:text-foreground">
          {entry.name}
        </span>

        {/* File size (subtle) */}
        {!isDir && entry.size !== null && (
          <span className="text-[10px] text-muted-foreground ml-1 shrink-0 opacity-0 group-hover:opacity-100">
            {fileSize(entry.size)}
          </span>
        )}

        {/* Action buttons — appear on hover */}
        {actionsVisible && (
          <div
            className="flex items-center gap-0.5 ml-1 shrink-0"
            onClick={e => e.stopPropagation()}
          >
            {!isDir && (
              <ActionBtn title="Download" onClick={() => onDownload(entry)}>
                <Download size={11} />
              </ActionBtn>
            )}
            {!isDir && (
              <ActionBtn title="Copy" onClick={() => onCopy(entry)}>
                <Copy size={11} />
              </ActionBtn>
            )}
            <ActionBtn title="Rename" onClick={() => onRename(entry)}>
              <Edit2 size={11} />
            </ActionBtn>
            <ActionBtn title="Delete" onClick={() => onDelete(entry)} danger>
              <Trash2 size={11} />
            </ActionBtn>
          </div>
        )}
      </div>

      {/* Children */}
      {isDir && expanded && children && children.length > 0 && (
        <div>
          {children.map(child => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onDelete={onDelete}
              onRename={onRename}
              onCopy={onCopy}
              onDownload={onDownload}
              onRefresh={onRefresh}
              refreshToken={refreshToken}
            />
          ))}
        </div>
      )}
      {isDir && expanded && children && children.length === 0 && (
        <div
          className="text-[10px] text-muted-foreground py-1"
          style={{ paddingLeft: `${indent + 24}px` }}
        >
          (empty)
        </div>
      )}
    </div>
  );
}

// ─── Action Button ─────────────────────────────────────────────────────────────

function ActionBtn({ children, title, onClick, danger }: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'p-0.5 rounded transition-colors',
        danger
          ? 'hover:bg-destructive/20 text-muted-foreground hover:text-destructive'
          : 'hover:bg-accent text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

// ─── File Icon ─────────────────────────────────────────────────────────────────

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const colorMap: Record<string, string> = {
    py: 'text-yellow-400',
    js: 'text-yellow-300',
    ts: 'text-blue-400',
    tsx: 'text-blue-300',
    jsx: 'text-yellow-300',
    json: 'text-orange-400',
    md: 'text-purple-400',
    txt: 'text-muted-foreground',
    csv: 'text-green-400',
    xlsx: 'text-green-500',
    pdf: 'text-red-400',
    png: 'text-pink-400',
    jpg: 'text-pink-400',
    jpeg: 'text-pink-400',
    svg: 'text-cyan-400',
    sh: 'text-green-300',
    html: 'text-orange-300',
    css: 'text-blue-300',
    sql: 'text-teal-400',
  };
  const color = colorMap[ext] || 'text-muted-foreground';
  return <File size={13} className={color} />;
}
