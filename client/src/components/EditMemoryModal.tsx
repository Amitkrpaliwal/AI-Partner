import { API_BASE } from '@/lib/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2, Plus, Brain } from 'lucide-react';
import { useState, useEffect } from 'react';

interface MemoryItem {
    category: string;
    key: string;
    value: any;
}

interface EditMemoryModalProps {
    isOpen: boolean;
    onClose: () => void;
}

export function EditMemoryModal({ isOpen, onClose }: EditMemoryModalProps) {
    const [memories, setMemories] = useState<MemoryItem[]>([]);
    const [loading, setLoading] = useState(false);

    // New Item State
    const [newCategory, setNewCategory] = useState('userPreferences');
    const [newKey, setNewKey] = useState('');
    const [newValue, setNewValue] = useState('');

    useEffect(() => {
        if (isOpen) {
            fetchMemories();
        }
    }, [isOpen]);

    async function fetchMemories() {
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/memory/core`);
            const data = await res.json();
            setMemories(data.memory || []);
        } catch (e) {
            console.error('Failed to fetch memory', e);
        } finally {
            setLoading(false);
        }
    }

    async function handleAdd() {
        if (!newKey || !newValue) return;

        try {
            await fetch(`${API_BASE}/api/memory/core`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category: newCategory, key: newKey, value: newValue })
            });

            // Optimization: Optimistic update or refetch
            setMemories([...memories, { category: newCategory, key: newKey, value: newValue }]);
            setNewKey('');
            setNewValue('');
        } catch (e) {
            console.error('Failed to add memory', e);
        }
    }

    async function handleDelete(category: string, key: string) {
        try {
            await fetch(`${API_BASE}/api/memory/core`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category, key })
            });

            setMemories(memories.filter(m => !(m.category === category && m.key === key)));
        } catch (e) {
            console.error('Failed to delete memory', e);
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Brain className="h-5 w-5 text-purple-500" />
                        Core Memory Editor
                    </DialogTitle>
                </DialogHeader>

                <div className="space-y-6">
                    {/* Add New Section */}
                    <div className="p-4 bg-accent/20 rounded-lg border border-border space-y-3">
                        <h4 className="text-sm font-medium uppercase text-muted-foreground">Add New Memory</h4>
                        <div className="flex gap-2">
                            <Input
                                placeholder="Category"
                                value={newCategory}
                                onChange={e => setNewCategory(e.target.value)}
                                className="w-1/4"
                            />
                            <Input
                                placeholder="Key (e.g., framework)"
                                value={newKey}
                                onChange={e => setNewKey(e.target.value)}
                                className="w-1/4"
                            />
                            <Input
                                placeholder="Value (e.g., React)"
                                value={newValue}
                                onChange={e => setNewValue(e.target.value)}
                                className="flex-1"
                            />
                            <Button onClick={handleAdd} size="icon">
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>

                    {/* Memory List */}
                    <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                        <h4 className="text-sm font-medium uppercase text-muted-foreground">Existing Memories</h4>
                        {loading ? (
                            <div className="text-center py-4 text-muted-foreground">Loading...</div>
                        ) : memories.length === 0 ? (
                            <div className="text-center py-4 text-muted-foreground italic">No core memories stored.</div>
                        ) : (
                            <div className="grid gap-2">
                                {memories.map((mem, i) => (
                                    <div key={i} className="flex items-center justify-between p-3 bg-card border border-border rounded-lg group hover:border-primary/30 transition-colors">
                                        <div className="flex flex-col gap-1">
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs font-bold text-muted-foreground bg-accent px-1.5 py-0.5 rounded">
                                                    {mem.category}
                                                </span>
                                                <span className="text-sm font-mono text-blue-400">{mem.key}</span>
                                            </div>
                                            <div className="text-sm text-foreground/90 pl-1">{String(mem.value).replace(/^"|"$/g, '')}</div>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => handleDelete(mem.category, mem.key)}
                                            className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <DialogFooter>
                    <Button onClick={onClose} variant="secondary">Close</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
