import express from 'express';
import { taskScheduler } from '../services/TaskScheduler';

const router = express.Router();

// List all tasks
router.get('/', async (req, res) => {
    try {
        const tasks = await taskScheduler.getAllTasks();
        res.json({ tasks });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Get single task
router.get('/:id', async (req, res) => {
    try {
        const task = await taskScheduler.getTask(req.params.id);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.json({ task });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Get task execution history
router.get('/:id/history', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 10;
        const history = await taskScheduler.getTaskHistory(req.params.id, limit);
        res.json({ history });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Create new task
router.post('/', async (req, res) => {
    try {
        const { name, description, schedule, action, parameters } = req.body;
        // Basic validation
        if (!name || !schedule || !action) {
            return res.status(400).json({ error: 'Missing required fields: name, schedule, action' });
        }

        const id = await taskScheduler.createTask({
            name,
            description,
            schedule,
            action,
            parameters: parameters || {},
            enabled: true
        });

        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Update task
router.put('/:id', async (req, res) => {
    try {
        const updates = req.body;
        const task = await taskScheduler.updateTask(req.params.id, updates);
        if (!task) {
            return res.status(404).json({ error: 'Task not found' });
        }
        res.json({ success: true, task });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Pause task
router.post('/:id/pause', async (req, res) => {
    try {
        const success = await taskScheduler.pauseTask(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Resume task
router.post('/:id/resume', async (req, res) => {
    try {
        const success = await taskScheduler.resumeTask(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

// Delete task
router.delete('/:id', async (req, res) => {
    try {
        await taskScheduler.deleteTask(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: String(e) });
    }
});

export const tasksRouter = router;
