/**
 * ImageGenServer — AI image generation tool for the ReAct agent.
 *
 * Provider priority (auto-selected based on available keys):
 *   1. OpenAI DALL-E 3    → OPENAI_API_KEY
 *   2. Stability AI       → STABILITY_API_KEY
 *
 * The generated image is saved to /workspace/images/<name>.png and the
 * path is returned so the agent can reference it in reports or further steps.
 */

import fs from 'fs';
import path from 'path';
import { configManager } from '../../services/ConfigManager';

function detectProvider(): 'openai' | 'stability' | null {
    if (process.env.OPENAI_API_KEY) return 'openai';
    if (process.env.STABILITY_API_KEY) return 'stability';
    return null;
}

class ImageGenServer {
    isAvailable(): boolean {
        return detectProvider() !== null;
    }

    getTools() {
        return [
            {
                name: 'image_generate',
                description: 'Generate an image from a text prompt using AI (DALL-E 3 or Stability AI). Returns the saved file path.',
                inputSchema: {
                    type: 'object' as const,
                    properties: {
                        prompt: {
                            type: 'string',
                            description: 'Detailed description of the image to generate'
                        },
                        filename: {
                            type: 'string',
                            description: 'Output filename without extension (default: "image"). Saved as /workspace/images/<filename>.png'
                        },
                        size: {
                            type: 'string',
                            description: 'Image size: 1024x1024 | 1792x1024 | 1024x1792 (default: 1024x1024)'
                        },
                        quality: {
                            type: 'string',
                            description: 'Quality: standard | hd (default: standard, hd costs 2x)'
                        },
                        style: {
                            type: 'string',
                            description: 'Style: vivid | natural (default: vivid, for DALL-E 3 only)'
                        }
                    },
                    required: ['prompt']
                }
            }
        ];
    }

    async callTool(name: string, args: any): Promise<any> {
        if (name !== 'image_generate') {
            return { success: false, error: `Unknown tool: ${name}` };
        }

        const provider = detectProvider();
        if (!provider) {
            return {
                success: false,
                error: 'No image generation API key found. Set OPENAI_API_KEY (DALL-E 3) or STABILITY_API_KEY in .env'
            };
        }

        const filename = (args.filename || 'image').replace(/[^a-zA-Z0-9_-]/g, '_');
        const workspace = configManager.getWorkspaceDir();
        const imagesDir = path.join(workspace, 'images');
        fs.mkdirSync(imagesDir, { recursive: true });
        const outputPath = path.join(imagesDir, `${filename}.png`);

        try {
            if (provider === 'openai') {
                return await this.generateWithOpenAI(args, outputPath);
            } else {
                return await this.generateWithStability(args, outputPath);
            }
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async generateWithOpenAI(args: any, outputPath: string): Promise<any> {
        const res = await fetch('https://api.openai.com/v1/images/generations', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'dall-e-3',
                prompt: args.prompt,
                n: 1,
                size: args.size || '1024x1024',
                quality: args.quality || 'standard',
                style: args.style || 'vivid',
                response_format: 'b64_json'
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`OpenAI image API ${res.status}: ${err.substring(0, 300)}`);
        }

        const data: any = await res.json();
        const b64 = data.data[0].b64_json;
        const revisedPrompt = data.data[0].revised_prompt || args.prompt;

        fs.writeFileSync(outputPath, Buffer.from(b64, 'base64'));

        return {
            success: true,
            provider: 'dall-e-3',
            path: outputPath,
            revised_prompt: revisedPrompt,
            size: args.size || '1024x1024',
            message: `Image saved to ${outputPath}`
        };
    }

    private async generateWithStability(args: any, outputPath: string): Promise<any> {
        // Stability AI v2beta (SDXL / SD3)
        const formData = new FormData();
        formData.append('prompt', args.prompt);
        formData.append('output_format', 'png');

        const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.STABILITY_API_KEY}`,
                'Accept': 'image/*'
            },
            body: formData
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Stability AI ${res.status}: ${err.substring(0, 300)}`);
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(outputPath, buffer);

        return {
            success: true,
            provider: 'stability-ai',
            path: outputPath,
            message: `Image saved to ${outputPath}`
        };
    }
}

export const imageGenServer = new ImageGenServer();
