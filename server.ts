/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '15mb' }));

// Initialize GoogleGenAI client
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Health check endpoint
app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    hasApiKey: !!process.env.GEMINI_API_KEY,
  });
});

// Helper to generate a single panel image using Gemini
async function generatePanelIllustration(
  imagePrompt: string,
  artStyle: string,
  characterProfileText: string
): Promise<{ imageUrl: string | null; error?: string }> {
  if (!ai) {
    return { imageUrl: null, error: 'GEMINI_API_KEY not configured' };
  }

  try {
    const fullPrompt = `Art Style: ${artStyle}. Visual scene: ${imagePrompt}. Character details: ${characterProfileText}. High quality comic book panel illustration, crisp focus, vibrant colors, comic art aesthetic, highly detailed background, dynamic composition. Strictly NO text, NO speech bubbles, NO words, NO logos inside the artwork.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite-image',
      contents: {
        parts: [{ text: fullPrompt }],
      },
      config: {
        imageConfig: {
          aspectRatio: '4:3',
        },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        return {
          imageUrl: `data:${mime};base64,${part.inlineData.data}`,
        };
      }
    }

    return { imageUrl: null, error: 'No image data returned from model' };
  } catch (err: any) {
    console.warn('Image generation warning/fallback:', err?.message || err);
    return {
      imageUrl: null,
      error: err?.message || 'Image model limit reached or unavailable',
    };
  }
}

// Single Panel Image Generation / Retry Route
app.post('/api/comic/generate-image', async (req: Request, res: Response) => {
  const { imagePrompt, artStyle, characterProfileText } = req.body;

  if (!imagePrompt) {
    return res.status(400).json({ error: 'Image prompt is required' });
  }

  const result = await generatePanelIllustration(
    imagePrompt,
    artStyle || 'Comic Book',
    characterProfileText || ''
  );

  if (result.imageUrl) {
    return res.json({ success: true, imageUrl: result.imageUrl });
  } else {
    return res.status(502).json({
      success: false,
      error: result.error || 'Failed to generate image',
      fallbackRequired: true,
    });
  }
});

// Full Comic Generation Route
app.post('/api/comic/generate', async (req: Request, res: Response) => {
  try {
    const { storyPrompt, characterName, setting, tone, artStyle } = req.body;

    // Strict validation
    if (!storyPrompt || typeof storyPrompt !== 'string' || !storyPrompt.trim()) {
      return res.status(400).json({ error: 'Please enter a story prompt.' });
    }
    if (!characterName || typeof characterName !== 'string' || !characterName.trim()) {
      return res.status(400).json({ error: 'Please enter a character name.' });
    }
    if (!setting) {
      return res.status(400).json({ error: 'Please select a setting.' });
    }
    if (!tone) {
      return res.status(400).json({ error: 'Please select a story tone.' });
    }
    if (!artStyle) {
      return res.status(400).json({ error: 'Please select an art style.' });
    }

    if (storyPrompt.length > 1000) {
      return res.status(400).json({ error: 'Story prompt is too long. Please keep it under 1000 characters.' });
    }

    if (!ai) {
      return res.status(500).json({
        error: 'Gemini API key is not configured. Please ensure GEMINI_API_KEY is set in your environment variables.',
      });
    }

    // Step 1: Generate complete 5-panel story and character profile
    const systemPrompt = `You are a master comic book writer and storyboard director for ComicCraft.
Your job is to transform a story idea into a tightly plotted, captivating 5-panel comic story.

Follow these strict storytelling rules:
1. Exactly 5 Panels with a complete narrative arc:
   - Panel 1: Introduction (hook, protagonist introduction in setting, initial state)
   - Panel 2: Development (discovery, progression, or rising action)
   - Panel 3: Conflict or Major Event (twist, obstacle, antagonist, danger, or mystery reveal)
   - Panel 4: Climax (decisive action, confrontation, or critical turning point)
   - Panel 5: Resolution (aftermath, consequence, triumphant ending, or humorous punchline)

2. Character Consistency:
   - Create a vivid, memorable CharacterProfile for "${characterName}".
   - Every single panel must preserve the character's signature visual features (hair, eyes, build, clothing, color palette).
   - In each panel's "image_prompt", explicitly describe the character's exact appearance so an illustrator would draw the exact same person.

3. Dialogue and Narration:
   - Narration: Evocative, comic-caption style voiceover (1-2 sentences).
   - Dialogue: 1 to 3 punchy lines per panel with speaker names matching the characters.
   - Tone: Consistently match the requested tone: "${tone}".
   - Setting: Ground every scene in the requested setting: "${setting}".
   - Art Style: Target style is "${artStyle}".

4. Image Prompts:
   - Describe camera angle (e.g. dramatic low angle, bird's-eye view, Dutch angle, tight close-up, wide panoramic shot).
   - Describe lighting and color atmosphere.
   - Describe character posture and facial emotion.
   - Explicitly instruct: "No text, no speech bubbles, no dialogue boxes inside the artwork."`;

    const userPrompt = `Create a 5-panel comic for:
- Story Prompt: "${storyPrompt.trim()}"
- Main Character Name: "${characterName.trim()}"
- Setting: "${setting}"
- Tone: "${tone}"
- Art Style: "${artStyle}"`;

    const storyGenConfig = {
      systemInstruction: systemPrompt,
      temperature: 0.8,
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Catchy, dramatic comic book title',
          },
          logline: {
            type: Type.STRING,
            description: 'One sentence hook/summary of the comic',
          },
          characterProfile: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              visualAppearance: {
                type: Type.STRING,
                description: 'Detailed physical appearance: build, species/ethnicity, hair style & color, eye color, defining marks',
              },
              signatureClothing: {
                type: Type.STRING,
                description: 'Exact signature outfit, clothing colors, and key accessories or props',
              },
              colorPalette: {
                type: Type.STRING,
                description: 'Primary colors associated with the character',
              },
            },
            required: ['name', 'visualAppearance', 'signatureClothing', 'colorPalette'],
          },
          panels: {
            type: Type.ARRAY,
            description: 'Array of exactly 5 sequential panels',
            items: {
              type: Type.OBJECT,
              properties: {
                panel_number: { type: Type.INTEGER },
                title: { type: Type.STRING },
                scene_description: { type: Type.STRING },
                narration: { type: Type.STRING },
                dialogue: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      character: { type: Type.STRING },
                      text: { type: Type.STRING },
                    },
                    required: ['character', 'text'],
                  },
                },
                image_prompt: {
                  type: Type.STRING,
                  description: 'Detailed visual prompt for illustrator describing shot composition, lighting, character pose, background, and art style. Must specify NO text inside the image.',
                },
              },
              required: [
                'panel_number',
                'title',
                'scene_description',
                'narration',
                'dialogue',
                'image_prompt',
              ],
            },
          },
        },
        required: ['title', 'logline', 'characterProfile', 'panels'],
      },
    };

    // Try primary model (gemini-3.8-flash) with fallback to gemini-3.1-flash-lite and gemini-flash-latest
    let response: any;
    try {
      response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: storyGenConfig,
      });
    } catch (primaryErr: any) {
      console.warn('Primary model error, attempting fallback to gemini-3.1-flash-lite:', primaryErr?.message || primaryErr);
      try {
        response = await ai.models.generateContent({
          model: 'gemini-3.1-flash-lite',
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: storyGenConfig,
        });
      } catch (secondErr: any) {
        console.warn('Secondary model error, attempting fallback to gemini-flash-latest:', secondErr?.message || secondErr);
        response = await ai.models.generateContent({
          model: 'gemini-flash-latest',
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          config: storyGenConfig,
        });
      }
    }

    const rawText = response.text?.trim() || '{}';
    let storyData: any;
    try {
      storyData = JSON.parse(rawText);
    } catch (parseErr) {
      console.error('Failed to parse Gemini JSON output:', rawText);
      // Attempt safe recovery regex
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        storyData = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Unable to parse comic structure from Gemini response.');
      }
    }

    if (!storyData.panels || !Array.isArray(storyData.panels) || storyData.panels.length === 0) {
      throw new Error('Comic panels were not generated properly.');
    }

    // Step 2: Attempt image generation for each panel
    const characterProfileSummary = `${storyData.characterProfile.name}: ${storyData.characterProfile.visualAppearance}, wearing ${storyData.characterProfile.signatureClothing}`;

    // Generate panel images in parallel with graceful per-panel catch
    const imagePromises = storyData.panels.map(async (panel: any) => {
      try {
        const imgResult = await generatePanelIllustration(
          panel.image_prompt,
          artStyle,
          characterProfileSummary
        );

        if (imgResult.imageUrl) {
          return {
            ...panel,
            imageUrl: imgResult.imageUrl,
            imageStatus: 'ready' as const,
          };
        } else {
          return {
            ...panel,
            imageUrl: null,
            imageStatus: 'fallback' as const,
            imageFallbackReason: 'Image model limit reached; stylized comic vector artwork displayed.',
          };
        }
      } catch (err: any) {
        return {
          ...panel,
          imageUrl: null,
          imageStatus: 'fallback' as const,
          imageFallbackReason: 'Image model limit reached; stylized comic vector artwork displayed.',
        };
      }
    });

    const panelsWithImages = await Promise.all(imagePromises);

    const completedStory = {
      id: 'comic-' + Date.now(),
      title: storyData.title || 'Untitled Comic Adventure',
      logline: storyData.logline || storyPrompt,
      characterProfile: storyData.characterProfile,
      panels: panelsWithImages,
      input: {
        storyPrompt,
        characterName,
        setting,
        tone,
        artStyle,
      },
      createdAt: new Date().toISOString(),
    };

    return res.json({ success: true, comic: completedStory });
  } catch (error: any) {
    console.error('Comic generation error:', error);
    let friendlyMessage = 'Something went wrong while creating your comic. Please try again.';

    if (error?.message) {
      try {
        const parsed = JSON.parse(error.message);
        if (parsed?.error?.message) {
          friendlyMessage = parsed.error.message;
        } else {
          friendlyMessage = error.message;
        }
      } catch {
        friendlyMessage = error.message;
      }
    }

    // Clean up technical jargon for the user
    if (friendlyMessage.includes('high demand') || friendlyMessage.includes('503') || friendlyMessage.includes('UNAVAILABLE')) {
      friendlyMessage = 'The AI model is experiencing a temporary surge in traffic. Please try again in a few seconds!';
    }

    return res.status(500).json({
      error: friendlyMessage,
    });
  }
});

// Client Vite middleware in dev or static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.resolve(__dirname, 'dist')));
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
  });
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ComicCraft server running on http://0.0.0.0:${PORT}`);
});
