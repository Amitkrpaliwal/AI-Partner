import express from 'express';
import { speechService } from '../services/SpeechService';

const router = express.Router();

/**
 * POST /api/voice/tts
 * Text-to-Speech: convert text to audio
 * Body: { text, voice?, speed?, format? }
 * Returns: audio file (binary)
 */
router.post('/tts', async (req, res) => {
    try {
        const { text, voice, speed, format } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });

        const audio = await speechService.textToSpeech(text, { voice, speed, format });

        const contentType = {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            opus: 'audio/opus',
            aac: 'audio/aac',
            flac: 'audio/flac'
        }[format || 'mp3'] || 'audio/mpeg';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', audio.length.toString());
        res.send(audio);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/voice/stt
 * Speech-to-Text: transcribe audio to text
 * Body: multipart/form-data with 'audio' file
 * Returns: { text }
 */
router.post('/stt', express.raw({ type: 'audio/*', limit: '25mb' }), async (req, res) => {
    try {
        const audio = req.body as Buffer;
        if (!audio || audio.length === 0) {
            return res.status(400).json({ error: 'Audio data is required' });
        }

        const language = req.query.language as string | undefined;
        const text = await speechService.speechToText(audio, { language });
        res.json({ text });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/voice/chat
 * Voice-to-voice chat: transcribe audio, send to LLM, return TTS response
 * Body: multipart/form-data with 'audio' file
 * Returns: { text, audioUrl? }
 */
router.post('/chat', express.raw({ type: 'audio/*', limit: '25mb' }), async (req, res) => {
    try {
        const audio = req.body as Buffer;
        if (!audio || audio.length === 0) {
            return res.status(400).json({ error: 'Audio data is required' });
        }

        // STT: transcribe user's voice
        const userText = await speechService.speechToText(audio);

        // Send to chat (import dynamically to avoid circular deps)
        const { agentOrchestrator } = await import('../services/AgentOrchestrator');
        const result = await agentOrchestrator.chat('default', userText);

        // TTS: synthesize response to file
        let audioUrl = null;
        try {
            const audioPath = await speechService.synthesizeToFile(result.response);
            audioUrl = `/api/voice/audio/${encodeURIComponent(require('path').basename(audioPath))}`;
        } catch {
            // TTS might fail — return text anyway
        }

        res.json({
            userText,
            response: result.response,
            audioUrl
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/voice/status
 * Get speech service status
 */
router.get('/status', (_req, res) => {
    res.json(speechService.getStatus());
});

export { router as voiceRoutes };
