import { API_BASE } from '@/lib/api';
import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import {
    Download, FileText, FileSpreadsheet, Presentation,
    FileCode, Trash2, Loader2, RefreshCw, FolderOpen,
    ChevronDown, ChevronUp, ExternalLink
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

interface GeneratedFile {
    id: string;
    filename: string;
    file_type: string;
    file_path: string;
    file_size: number;
    mime_type: string;
    title: string;
    description?: string;
    created_at: string;
    download_count: number;
}

interface FileStats {
    total_files: number;
    total_size: number;
    total_downloads: number;
    by_type: { file_type: string; count: number; size: number }[];
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const getFileIcon = (fileType: string) => {
    switch (fileType) {
        case 'pptx':
            return <Presentation className="w-5 h-5 text-orange-500" />;
        case 'xlsx':
            return <FileSpreadsheet className="w-5 h-5 text-green-500" />;
        case 'docx':
            return <FileText className="w-5 h-5 text-blue-500" />;
        case 'html':
            return <FileCode className="w-5 h-5 text-purple-500" />;
        case 'pdf':
            return <FileText className="w-5 h-5 text-red-500" />;
        default:
            return <FileText className="w-5 h-5 text-gray-500" />;
    }
};

const getFileTypeBadge = (fileType: string) => {
    const colors: Record<string, string> = {
        pptx: 'bg-orange-500/10 text-orange-500',
        xlsx: 'bg-green-500/10 text-green-500',
        docx: 'bg-blue-500/10 text-blue-500',
        html: 'bg-purple-500/10 text-purple-500',
        pdf: 'bg-red-500/10 text-red-500'
    };
    return colors[fileType] || 'bg-gray-500/10 text-gray-500';
};

// ============================================================================
// COMPONENT
// ============================================================================

export function DeliverableDownloader() {
    const [files, setFiles] = useState<GeneratedFile[]>([]);
    const [stats, setStats] = useState<FileStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(true);
    const [filterType, setFilterType] = useState<string>('');
    const [downloading, setDownloading] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<string | null>(null);

    // Load files on mount
    useEffect(() => {
        loadFiles();
        loadStats();
    }, [filterType]);

    const loadFiles = async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (filterType) params.append('type', filterType);
            params.append('limit', '20');

            const response = await fetch(`${API_BASE}/api/files?${params}`);
            if (response.ok) {
                const data = await response.json();
                setFiles(data.files || []);
            }
        } catch (e) {
            console.error('Failed to load files:', e);
        } finally {
            setLoading(false);
        }
    };

    const loadStats = async () => {
        try {
            const response = await fetch(`${API_BASE}/api/files/stats/summary`);
            if (response.ok) {
                const data = await response.json();
                setStats(data);
            }
        } catch (e) {
            console.error('Failed to load stats:', e);
        }
    };

    const handleDownload = async (file: GeneratedFile) => {
        setDownloading(file.id);
        try {
            const response = await fetch(`${API_BASE}/api/files/${file.id}/download`);
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = file.filename;
                document.body.appendChild(a);
                a.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(a);
                // Refresh to update download count
                loadFiles();
            } else {
                console.error('Download failed');
            }
        } catch (e) {
            console.error('Download error:', e);
        } finally {
            setDownloading(null);
        }
    };

    const handleDelete = async (file: GeneratedFile) => {
        if (!confirm(`Delete "${file.filename}"?`)) return;

        setDeleting(file.id);
        try {
            const response = await fetch(`${API_BASE}/api/files/${file.id}`, {
                method: 'DELETE'
            });
            if (response.ok) {
                setFiles(prev => prev.filter(f => f.id !== file.id));
                loadStats();
            }
        } catch (e) {
            console.error('Delete error:', e);
        } finally {
            setDeleting(null);
        }
    };

    return (
        <Card>
            <CardHeader className="pb-2">
                <button
                    onClick={() => setExpanded(!expanded)}
                    className="flex items-center justify-between w-full"
                >
                    <CardTitle className="flex items-center gap-2 text-lg">
                        <FolderOpen className="w-5 h-5" />
                        Generated Files
                        {files.length > 0 && (
                            <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                                {files.length}
                            </span>
                        )}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                loadFiles();
                                loadStats();
                            }}
                            className="p-1 hover:bg-muted rounded"
                        >
                            <RefreshCw className="w-4 h-4 text-muted-foreground" />
                        </button>
                        {expanded ? (
                            <ChevronUp className="w-4 h-4 text-muted-foreground" />
                        ) : (
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                        )}
                    </div>
                </button>
            </CardHeader>

            {expanded && (
                <CardContent className="space-y-4">
                    {/* Stats summary */}
                    {stats && (
                        <div className="flex gap-4 text-xs text-muted-foreground">
                            <span>{stats.total_files} files</span>
                            <span>{formatFileSize(stats.total_size || 0)}</span>
                            <span>{stats.total_downloads || 0} downloads</span>
                        </div>
                    )}

                    {/* Filter */}
                    <div className="flex gap-2">
                        <button
                            onClick={() => setFilterType('')}
                            className={`px-2 py-1 text-xs rounded ${!filterType ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                        >
                            All
                        </button>
                        {['pptx', 'xlsx', 'docx', 'html'].map(type => (
                            <button
                                key={type}
                                onClick={() => setFilterType(type)}
                                className={`px-2 py-1 text-xs rounded uppercase ${filterType === type ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                            >
                                {type}
                            </button>
                        ))}
                    </div>

                    {/* File list */}
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                        </div>
                    ) : files.length === 0 ? (
                        <div className="text-center py-8 text-muted-foreground">
                            <FolderOpen className="w-12 h-12 mx-auto mb-2 opacity-50" />
                            <p>No generated files yet</p>
                            <p className="text-xs mt-1">Files will appear here when generated</p>
                        </div>
                    ) : (
                        <div className="space-y-2 max-h-80 overflow-y-auto">
                            {files.map(file => (
                                <div
                                    key={file.id}
                                    className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/50 transition-colors"
                                >
                                    {/* Icon */}
                                    {getFileIcon(file.file_type)}

                                    {/* Info */}
                                    <div className="flex-1 min-w-0">
                                        <div className="font-medium text-sm truncate" title={file.filename}>
                                            {file.title || file.filename}
                                        </div>
                                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                            <span className={`px-1.5 py-0.5 rounded uppercase ${getFileTypeBadge(file.file_type)}`}>
                                                {file.file_type}
                                            </span>
                                            <span>{formatFileSize(file.file_size)}</span>
                                            <span>{formatDate(file.created_at)}</span>
                                            {file.download_count > 0 && (
                                                <span className="flex items-center gap-0.5">
                                                    <Download className="w-3 h-3" />
                                                    {file.download_count}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Actions */}
                                    <div className="flex items-center gap-1">
                                        <button
                                            onClick={() => handleDownload(file)}
                                            disabled={downloading === file.id}
                                            className="p-2 hover:bg-primary/10 rounded-md text-primary disabled:opacity-50"
                                            title="Download"
                                        >
                                            {downloading === file.id ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <Download className="w-4 h-4" />
                                            )}
                                        </button>
                                        {file.file_type === 'html' && (
                                            <button
                                                onClick={() => window.open(`/api/files/${file.id}/download`, '_blank')}
                                                className="p-2 hover:bg-muted rounded-md text-muted-foreground"
                                                title="Open in new tab"
                                            >
                                                <ExternalLink className="w-4 h-4" />
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleDelete(file)}
                                            disabled={deleting === file.id}
                                            className="p-2 hover:bg-red-500/10 rounded-md text-red-500 disabled:opacity-50"
                                            title="Delete"
                                        >
                                            {deleting === file.id ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <Trash2 className="w-4 h-4" />
                                            )}
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </CardContent>
            )}
        </Card>
    );
}
