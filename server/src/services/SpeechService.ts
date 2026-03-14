import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { configManager } from './ConfigManager';

/**
 * SpeechService — TTS and STT for voice-enabled AI interaction.
 *
 * Supports multiple providers:
 * - TTS: OpenAI TTS, ElevenLabs, browser-native (fallback)
 * - STT: OpenAI Whisper, browser-native (fallback)
 *
 * Usage:
 *   const audio = await speechService.textToSpeech("Hello world");
 *   const text = await speechService.speechToText(audioBuffer);
 */

export interface TTSOptions {
    voice?: string;       // Voice ID or name
    speed?: number;       // Playback speed (0.5–2.0)
    model?: string;       // e.g. 'tts-1', 'tts-1-hd'
    format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac';
}

export interface STTOptions {
    language?: string;    // ISO 639-1 language code
    model?: string;       // e.g. 'whisper-1'
    prompt?: string;      // Prior context to guide recognition
}

export interface SpeechProvider {
    name: string;
    tts(text: string, options?: TTSOptions): Promise<Buffer>;
    stt(audio: Buffer, options?: STTOptions): Promise<string>;
    isAvailable(): Promise<boolean>;
}

// ==========================================================================
// OpenAI Speech Provider
// ==========================================================================

class OpenAISpeechProvider implements SpeechProvider {
    name = 'openai';
    private apiKey: string;
    private baseURL: string;

    constructor() {
        this.apiKey = process.env.OPENAI_API_KEY || '';
        this.baseURL = 'https://api.openai.com/v1';
    }

    async tts(text: string, options: TTSOptions = {}): Promise<Buffer> {
        const response = await axios.post(
            `${this.baseURL}/audio/speech`,
            {
                model: options.model || 'tts-1',
                input: text,
                voice: options.voice || 'alloy',
                speed: options.speed || 1.0,
                response_format: options.format || 'mp3'
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                responseType: 'arraybuffer'
            }
        );
        return Buffer.from(response.data);
    }

    async stt(audio: Buffer, options: STTOptions = {}): Promise<string> {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('file', audio, { filename: 'audio.wav', contentType: 'audio/wav' });
        form.append('model', options.model || 'whisper-1');
        if (options.language) form.append('language', options.language);
        if (options.prompt) form.append('prompt', options.prompt);

        const response = await axios.post(
            `${this.baseURL}/audio/transcriptions`,
            form,
            {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    ...form.getHeaders()
                }
            }
        );
        return response.data.text;
    }

    async isAvailable(): Promise<boolean> {
        return !!this.apiKey;
    }
}

// ==========================================================================
// ElevenLabs Speech Provider
// ==========================================================================

class ElevenLabsSpeechProvider implements SpeechProvider {
    name = 'elevenlabs';
    private apiKey: string;
    private baseURL = 'https://api.elevenlabs.io/v1';

    constructor() {
        this.apiKey = process.env.ELEVENLABS_API_KEY || '';
    }

    async tts(text: string, options: TTSOptions = {}): Promise<Buffer> {
        const voiceId = options.voice || '21m00Tcm4TlvDq8ikWAM'; // "Rachel" default
        const response = await axios.post(
            `${this.baseURL}/text-to-speech/${voiceId}`,
            {
                text,
                model_id: options.model || 'eleven_monolingual_v1',
                voice_settings: {
                    stability: 0.5,
                    similarity_boost: 0.75,
                    speed: options.speed || 1.0
                }
            },
            {
                headers: {
                    'xi-api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                responseType: 'arraybuffer'
            }
        );
        return Buffer.from(response.data);
    }

    async stt(_audio: Buffer, _options?: STTOptions): Promise<string> {
        throw new Error('ElevenLabs does not support STT — use OpenAI Whisper instead');
    }

    async isAvailable(): Promise<boolean> {
        return !!this.apiKey;
    }
}

// ==========================================================================
// SpeechService Manager
// ==========================================================================

export class SpeechService {
    private providers: SpeechProvider[] = [];
    private ttsProvider: SpeechProvider | null = null;
    private sttProvider: SpeechProvider | null = null;

    constructor() {
        this.providers.push(new OpenAISpeechProvider());
        this.providers.push(new ElevenLabsSpeechProvider());
    }

    async initialize(): Promise<void> {
        for (const provider of this.providers) {
            try {
                if (await provider.isAvailable()) {
                    if (!this.ttsProvider) {
                        this.ttsProvider = provider;
                        console.log(`[SpeechService] TTS: ${provider.name}`);
                    }
                    if (!this.sttProvider && provider.name === 'openai') {
                        this.sttProvider = provider;
                        console.log(`[SpeechService] STT: ${provider.name}`);
                    }
                }
            } catch (e) {
                // Provider not available
            }
        }
        if (!this.ttsProvider) {
            console.log('[SpeechService] No TTS provider available (set OPENAI_API_KEY or ELEVENLABS_API_KEY)');
        }
    }

    async textToSpeech(text: string, options?: TTSOptions): Promise<Buffer> {
        if (!this.ttsProvider) throw new Error('No TTS provider available');
        return this.ttsProvider.tts(text, options);
    }

    async speechToText(audio: Buffer, options?: STTOptions): Promise<string> {
        if (!this.sttProvider) throw new Error('No STT provider available');
        return this.sttProvider.stt(audio, options);
    }

    /**
     * Save TTS output to a file and return the path
     */
    async synthesizeToFile(text: string, options?: TTSOptions): Promise<string> {
        const audio = await this.textToSpeech(text, options);
        const appDir = configManager.getAppDataDir();
        const audioDir = path.join(appDir, 'audio');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

        const ext = options?.format || 'mp3';
        const filename = `tts_${Date.now()}.${ext}`;
        const filePath = path.join(audioDir, filename);
        fs.writeFileSync(filePath, audio);
        return filePath;
    }

    getStatus(): { tts: string | null; stt: string | null } {
        return {
            tts: this.ttsProvider?.name || null,
            stt: this.sttProvider?.name || null
        };
    }
}

export const speechService = new SpeechService();
