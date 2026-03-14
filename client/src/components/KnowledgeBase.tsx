import { API_BASE } from '@/lib/api';
import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Upload, Search, FileText, Trash2, Loader2 } from 'lucide-react';

interface KnowledgeDocument {
    id: string;
    title: string;
    source: string;
    content_type: string;
    chunk_count: number;
    total_chars: number;
    created_at: string;
}

interface SearchResult {
    chunk_id: string;
    document_id: string;
    document_title: string;
    content: string;
    similarity: number;
    chunk_index: number;
}

export function KnowledgeBase() {
    const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadStatus, setUploadStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    // Upload form state
    const [uploadTitle, setUploadTitle] = useState('');
    const [uploadContent, setUploadContent] = useState('');

    useEffect(() => {
        loadDocuments();
    }, []);

    const loadDocuments = async () => {
        try {
            const res = await fetch(`${API_BASE}/api/knowledge/documents`);
            const data = await res.json();
            setDocuments(data.documents || []);
        } catch (e) {
            console.error('Failed to load documents:', e);
        }
    };

    const handleUpload = async () => {
        if (!uploadTitle.trim() || !uploadContent.trim()) {
            alert('Please provide both title and content');
            return;
        }

        setIsUploading(true);
        setUploadStatus(null);
        try {
            const res = await fetch(`${API_BASE}/api/knowledge/ingest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: uploadTitle,
                    content: uploadContent,
                    source: 'manual-upload'
                })
            });
            const data = await res.json();
            if (data.success && data.document) {
                setUploadTitle('');
                setUploadContent('');
                setUploadStatus({ type: 'success', message: `? "${data.document.title}" ingested — ${data.document.chunk_count} chunks stored in database.` });
                await loadDocuments();
            } else {
                setUploadStatus({ type: 'error', message: data.error || 'Upload failed' });
            }
        } catch (e) {
            console.error('Upload failed:', e);
            setUploadStatus({ type: 'error', message: 'Network error — is the server running?' });
        } finally {
            setIsUploading(false);
        }
    };

    const handleSearch = async () => {
        if (!searchQuery.trim()) return;

        setIsSearching(true);
        try {
            const res = await fetch(`${API_BASE}/api/knowledge/search?q=${encodeURIComponent(searchQuery)}&limit=10`);
            const data = await res.json();
            setSearchResults(data.results || []);
        } catch (e) {
            console.error('Search failed:', e);
        } finally {
            setIsSearching(false);
        }
    };

    const handleDelete = async (id: string) => {
        if (!confirm('Delete this document and all its chunks?')) return;

        try {
            await fetch(`${API_BASE}/api/knowledge/${id}`, {
                method: 'DELETE'
            });
            await loadDocuments();
        } catch (e) {
            console.error('Delete failed:', e);
        }
    };

    return (
        <div className="grid grid-cols-2 gap-4 h-full p-4 overflow-auto">
            {/* Left: Upload & Documents */}
            <div className="space-y-4">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Upload className="w-5 h-5" />
                            Upload Document
                        </CardTitle>
                        <CardDescription>
                            Upload text content to the knowledge base. It will be chunked and embedded for semantic search.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <Input
                            placeholder="Document title"
                            value={uploadTitle}
                            onChange={(e) => setUploadTitle(e.target.value)}
                        />
                        <Textarea
                            placeholder="Document content..."
                            value={uploadContent}
                            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setUploadContent(e.target.value)}
                            className="min-h-[200px] font-mono text-sm"
                        />
                        <Button
                            onClick={handleUpload}
                            disabled={isUploading || !uploadTitle.trim() || !uploadContent.trim()}
                            className="w-full"
                        >
                            {isUploading ? (
                                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Uploading...</>
                            ) : (
                                <><Upload className="w-4 h-4 mr-2" /> Upload Document</>
                            )}
                        </Button>
                        {uploadStatus && (
                            <div className={`text-sm p-2 rounded ${uploadStatus.type === 'success' ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'
                                }`}>
                                {uploadStatus.message}
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                            Documents are chunked and stored as vector embeddings in the local SQLite database for semantic retrieval.
                        </p>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <FileText className="w-5 h-5" />
                            Indexed Documents ({documents.length})
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        {documents.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No documents yet. Upload one to get started.</p>
                        ) : (
                            <div className="space-y-2 max-h-[400px] overflow-auto">
                                {documents.map(doc => (
                                    <div key={doc.id} className="flex items-center justify-between p-3 border rounded-lg">
                                        <div className="flex-1 min-w-0">
                                            <p className="font-medium truncate">{doc.title}</p>
                                            <p className="text-xs text-muted-foreground">
                                                {doc.chunk_count} chunks • {(doc.total_chars / 1000).toFixed(1)}k chars • {new Date(doc.created_at).toLocaleDateString()}
                                            </p>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => handleDelete(doc.id)}
                                        >
                                            <Trash2 className="w-4 h-4 text-destructive" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* Right: Search */}
            <div className="space-y-4">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Search className="w-5 h-5" />
                            Semantic Search
                        </CardTitle>
                        <CardDescription>
                            Search across all indexed documents using hybrid vector + keyword search.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex gap-2">
                            <Input
                                placeholder="Search query..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                            />
                            <Button
                                onClick={handleSearch}
                                disabled={isSearching || !searchQuery.trim()}
                            >
                                {isSearching ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                    <Search className="w-4 h-4" />
                                )}
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Results ({searchResults.length})</CardTitle>
                    </CardHeader>
                    <CardContent>
                        {searchResults.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No results yet. Try a search query above.</p>
                        ) : (
                            <div className="space-y-3 max-h-[600px] overflow-auto">
                                {searchResults.map((result) => (
                                    <div key={result.chunk_id} className="border rounded-lg p-3 space-y-1">
                                        <div className="flex items-center justify-between">
                                            <p className="text-sm font-medium">{result.document_title}</p>
                                            <span className="text-xs text-muted-foreground">
                                                similarity: {(result.similarity * 100).toFixed(1)}%
                                            </span>
                                        </div>
                                        <p className="text-sm text-muted-foreground">Chunk {result.chunk_index + 1}</p>
                                        <p className="text-sm mt-2 p-2 bg-muted rounded">
                                            {result.content.substring(0, 300)}
                                            {result.content.length > 300 && '...'}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
