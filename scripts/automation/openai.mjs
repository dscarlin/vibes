#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';

export async function transcribeAudio(config, filePath) {
  if (!config.openAiApiKey) {
    throw new Error('OPENAI_API_KEY is required for meeting transcription');
  }
  const form = new FormData();
  const bytes = await fs.readFile(filePath);
  form.set('file', new Blob([bytes]), path.basename(filePath));
  form.set('model', config.transcriptionModel);
  form.set('response_format', 'text');
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`
    },
    body: form
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI transcription failed (${response.status}): ${text}`);
  }
  return response.text();
}
