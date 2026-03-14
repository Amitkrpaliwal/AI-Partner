import { Router } from 'express';
import { knowledgeBase } from '../memory/KnowledgeBase';

export const knowledgeRoutes = Router();

// Search the knowledge base
knowledgeRoutes.get('/search', async (req, res) => {
    try {
        const { q, limit } = req.query;
        if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });

        const results = await knowledgeBase.search(
            q as string,
            limit ? parseInt(limit as string) : 5
        );
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// List indexed documents
knowledgeRoutes.get('/documents', async (req, res) => {
    try {
        const documents = await knowledgeBase.listDocuments();
        res.json({ documents });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Ingest text content
knowledgeRoutes.post('/ingest', async (req, res) => {
    try {
        const { title, content, source, content_type } = req.body;
        if (!title || !content) {
            return res.status(400).json({ error: 'Title and content are required' });
        }

        const doc = await knowledgeBase.ingestText(
            title, content, source || 'api', content_type || 'text'
        );
        res.json({ success: true, document: doc });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Ingest a file from workspace
knowledgeRoutes.post('/ingest-file', async (req, res) => {
    try {
        const { file_path, title } = req.body;
        if (!file_path) {
            return res.status(400).json({ error: 'file_path is required' });
        }

        const doc = await knowledgeBase.ingestFile(file_path, title);
        res.json({ success: true, document: doc });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Delete a document
knowledgeRoutes.delete('/:id', async (req, res) => {
    try {
        const deleted = await knowledgeBase.deleteDocument(req.params.id);
        res.json({ success: deleted });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});
