import { useState, useCallback, useRef, useEffect } from 'react';
import { Mic, MicOff, Volume2, VolumeX, X } from 'lucide-react';
import { API_BASE } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { useStore } from '@/store';

interface VoiceModeProps {
    onClose: () => void;
}

/**
 * VoiceMode — Full-screen push-to-talk voice interface.
 *
 * Flow:
 * 1. User holds mic button → records audio via MediaRecorder
 * 2. On release → sends to /api/voice/stt for transcription
 * 3. Transcription sent to chat via Socket.IO
 * 4. Response played back via /api/voice/tts (if TTS enabled)
 */
export function VoiceMode({ onClose }: VoiceModeProps) {
    const { activeConversationId, addMessage } = useStore();
    const [isRecording, setIsRecording] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const [transcript, setTranscript] = useState('');
    const [response, setResponse] = useState('');
    const [ttsEnabled, setTtsEnabled] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (mediaRecorderRef.current?.state === 'recording') {
                mediaRecorderRef.current.stop();
            }
            if (audioRef.current) {
                audioRef.current.pause();
            }
        };
    }, []);

    const startRecording = useCallback(async () => {
        setError(null);

        // Primary path: browser Web Speech API (free, no API key, Chrome/Edge)
        const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (SpeechRecognitionAPI) {
            const recognition = new SpeechRecognitionAPI();
            (window as any)._voiceRecognition = recognition;
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.lang = navigator.language || 'en-US';

            recognition.onresult = async (event: any) => {
                const text = event.results[0]?.[0]?.transcript;
                if (text) {
                    // Create a pseudo blob with just the text so processAudio can handle it
                    setTranscript(text);
                    await processTextAsVoice(text);
                }
            };
            recognition.onerror = (event: any) => {
                setError(`Speech recognition error: ${event.error}. Try Chrome/Edge.`);
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
                await processAudio(audioBlob);
            };

            mediaRecorder.start();
            setIsRecording(true);
        } catch (err) {
            setError('Microphone access denied. Please allow microphone access.');
            console.error('[VoiceMode] Mic error:', err);
        }
    }, []);

    const stopRecording = useCallback(() => {
        (window as any)._voiceRecognition?.stop();
        if (mediaRecorderRef.current?.state === 'recording') {
            mediaRecorderRef.current.stop();
        }
        setIsRecording(false);
    }, []);

    // Used by the Web Speech API path — text already transcribed, skip STT step
    const processTextAsVoice = async (text: string) => {
        setIsProcessing(true);
        setResponse('');
        try {
            if (activeConversationId) {
                addMessage(activeConversationId, {
                    id: `voice_${Date.now()}`,
                    role: 'user',
                    content: `🎤 ${text}`,
                    timestamp: Date.now()
                });
            }
            const socket = getSocket();
            socket.emit('message:send', { content: text, userId: 'default', mode: 'chat' });

            const responsePromise = new Promise<string>((resolve) => {
                const handler = (data: any) => {
                    if (data.done && data.content) {
                        socket.off('message:stream', handler);
                        resolve(data.content);
                    }
                };
                socket.on('message:stream', handler);
                setTimeout(() => { socket.off('message:stream', handler); resolve(''); }, 30000);
            });

            const aiResponse = await responsePromise;
            if (aiResponse) setResponse(aiResponse);

            if (ttsEnabled && aiResponse) {
                try {
                    const ttsRes = await fetch(`${API_BASE}/api/voice/tts`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: aiResponse })
                    });
                    if (ttsRes.ok) {
                        const audioBlob = await ttsRes.blob();
                        const audioUrl = URL.createObjectURL(audioBlob);
                        const audio = new Audio(audioUrl);
                        audioRef.current = audio;
                        audio.play();
                    }
                } catch { /* TTS optional */ }
            }
        } catch (err: any) {
            setError(`Error: ${err.message}`);
        } finally {
            setIsProcessing(false);
        }
    };

    const processAudio = async (audioBlob: Blob) => {
        setIsProcessing(true);
        setTranscript('');
        setResponse('');

        try {
            // Step 1: Speech-to-Text
            const sttRes = await fetch(`${API_BASE}/api/voice/stt`, {
                method: 'POST',
                headers: { 'Content-Type': 'audio/webm' },
                body: audioBlob
            });
            const sttData = await sttRes.json();

            if (!sttData.text) {
                setError('Could not transcribe audio. Please try again.');
                setIsProcessing(false);
                return;
            }

            setTranscript(sttData.text);

            // Step 2: Send to chat via Socket.IO
            if (activeConversationId) {
                addMessage(activeConversationId, {
                    id: `voice_${Date.now()}`,
                    role: 'user',
                    content: `🎤 ${sttData.text}`,
                    timestamp: Date.now()
                });
            }

            const socket = getSocket();
            socket.emit('message:send', {
                content: sttData.text,
                userId: 'default',
                mode: 'chat'
            });

            // Step 3: Wait for response (via Socket event)
            const responsePromise = new Promise<string>((resolve) => {
                const handler = (data: any) => {
                    if (data.done && data.content) {
                        socket.off('message:stream', handler);
                        resolve(data.content);
                    } else if (data.content) {
                        setResponse(data.content);
                    }
                };
                socket.on('message:stream', handler);
                // Timeout after 30s
                setTimeout(() => {
                    socket.off('message:stream', handler);
                    resolve(response || 'No response received.');
                }, 30000);
            });

            const finalResponse = await responsePromise;
            setResponse(finalResponse);

            // Step 4: TTS playback (optional)
            if (ttsEnabled && finalResponse) {
                try {
                    const ttsRes = await fetch(`${API_BASE}/api/voice/tts`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: finalResponse.substring(0, 500) }) // Limit TTS length
                    });

                    if (ttsRes.ok) {
                        const audioData = await ttsRes.arrayBuffer();
                        const blob = new Blob([audioData], { type: 'audio/mpeg' });
                        const url = URL.createObjectURL(blob);
                        const audio = new Audio(url);
                        audioRef.current = audio;
                        audio.play().catch(console.error);
                    }
                } catch {
                    // TTS not available — that's okay
                }
            }
        } catch (err: any) {
            setError(`Voice processing error: ${err.message}`);
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col items-center justify-center">
            {/* Close Button */}
            <button
                onClick={onClose}
                className="absolute top-4 right-4 p-2 rounded-full hover:bg-accent transition-colors"
            >
                <X size={24} />
            </button>

            {/* TTS Toggle */}
            <button
                onClick={() => setTtsEnabled(!ttsEnabled)}
                className="absolute top-4 left-4 p-2 rounded-full hover:bg-accent transition-colors"
                title={ttsEnabled ? 'Disable voice response' : 'Enable voice response'}
            >
                {ttsEnabled ? <Volume2 size={20} /> : <VolumeX size={20} />}
            </button>

            {/* Title */}
            <h2 className="text-xl font-semibold mb-8 text-muted-foreground">Voice Mode</h2>

            {/* Transcript Display */}
            {transcript && (
                <div className="max-w-md w-full mb-6 px-4">
                    <div className="bg-card border border-border rounded-lg p-3">
                        <div className="text-xs text-muted-foreground mb-1">You said:</div>
                        <div className="text-sm">{transcript}</div>
                    </div>
                </div>
            )}

            {/* Response Display */}
            {response && (
                <div className="max-w-md w-full mb-6 px-4">
                    <div className="bg-primary/5 border border-primary/20 rounded-lg p-3">
                        <div className="text-xs text-primary mb-1">AI:</div>
                        <div className="text-sm">{response.substring(0, 300)}{response.length > 300 ? '...' : ''}</div>
                    </div>
                </div>
            )}

            {/* Error Display */}
            {error && (
                <div className="max-w-md w-full mb-6 px-4">
                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm">
                        {error}
                    </div>
                </div>
            )}

            {/* Mic Button */}
            <div className="relative">
                {/* Pulse ring when recording */}
                {isRecording && (
                    <div className="absolute inset-0 -m-4 rounded-full bg-red-500/20 animate-ping" />
                )}

                <button
                    onMouseDown={startRecording}
                    onMouseUp={stopRecording}
                    onTouchStart={startRecording}
                    onTouchEnd={stopRecording}
                    disabled={isProcessing}
                    className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${isRecording
                            ? 'bg-red-500 scale-110 shadow-lg shadow-red-500/50'
                            : isProcessing
                                ? 'bg-yellow-500/20 cursor-wait'
                                : 'bg-primary hover:bg-primary/90 hover:scale-105'
                        }`}
                >
                    {isRecording ? (
                        <MicOff size={32} className="text-white" />
                    ) : isProcessing ? (
                        <div className="w-6 h-6 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                    ) : (
                        <Mic size={32} className="text-primary-foreground" />
                    )}
                </button>
            </div>

            <p className="mt-4 text-sm text-muted-foreground">
                {isRecording ? 'Recording... Release to send' : isProcessing ? 'Processing...' : 'Hold to speak'}
            </p>
        </div>
    );
}
