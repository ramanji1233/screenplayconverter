require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));
// Serve static files (HTML, CSS, JS) from project directory
app.use(express.static(__dirname));

// Health check endpoint
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the front-end at root to avoid "Cannot GET /"
const fs = require('fs');
app.get('/', (req, res) => {
  // Prefer `screenplayconvertermain.html` if present, otherwise fall back to `screenplayconverter.html`.
  const preferred = path.join(__dirname, 'screenplayconvertermain.html');
  const fallback = path.join(__dirname, 'screenplayconverter.html');
  if (fs.existsSync(preferred)) return res.sendFile(preferred);
  if (fs.existsSync(fallback)) return res.sendFile(fallback);
  // If neither exists, return a helpful message.
  res.status(404).send('Frontend not found. Place `screenplayconvertermain.html` or `screenplayconverter.html` in the project root.');
});

// ---------------- Freepik proxy (avoids CORS and hides API key) ----------------
const FREEPIK_API_URL = 'https://api.freepik.com/v1/ai/mystic';

async function pollFreepikTask(taskId, apiKey, maxAttempts = 60, intervalMs = 2000) {
  const endpoints = [
    `${FREEPIK_API_URL}/${taskId}`,
    `${FREEPIK_API_URL}?task_id=${taskId}`,
    `https://api.freepik.com/v1/ai/tasks/${taskId}`
  ];
  let working = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidates = working ? [working] : endpoints;
    for (const url of candidates) {
      try {
        const r = await fetch(url, { headers: { 'Accept': 'application/json', 'x-freepik-api-key': apiKey } });
        if (!r.ok) {
          console.log(`[Freepik Poll] Attempt ${attempt + 1}/${maxAttempts}: ${url} returned HTTP ${r.status}`);
          continue;
        }
        const data = await r.json();
        if (data && data.data) {
          const status = data.data.status;
          console.log(`[Freepik Poll] Attempt ${attempt + 1}: status=${status}, taskId=${taskId}`);
          if (!working) working = url;
          if (status === 'COMPLETED' || status === 'SUCCESS') {
            console.log(`[Freepik Poll] Task completed! Extracting image URL...`);
            if (data.data.generated && data.data.generated.length) {
              const image = data.data.generated[0];
              const imageUrl = image.url || image.image_url || image.imageUrl || image.src || (typeof image === 'string' ? image : null);
              console.log(`[Freepik Poll] Returning image URL: ${imageUrl ? imageUrl.substring(0, 100) : 'null'}`);
              return imageUrl;
            }
            return data.data.url || data.data.image_url || null;
          }
          if (status === 'FAILED' || status === 'ERROR') throw new Error(`Task failed: ${status}`);
        }
      } catch (_) { /* try next */ }
    }
    if (attempt % 10 === 0) console.log(`[Freepik Poll] Polling... attempt ${attempt + 1}/${maxAttempts}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
  console.error(`[Freepik Poll] Timeout after ${maxAttempts} attempts (${maxAttempts * intervalMs / 1000}s)`);
  throw new Error('Freepik polling timeout');
}

app.post('/api/freepik/generate', async (req, res) => {
  try {
    const apiKey = process.env.FREEPIK_API_KEY;
    console.log(`[Freepik Generate] Request received. API key present: ${!!apiKey}`);
    if (!apiKey) return res.status(400).json({ error: 'Freepik API key missing on server' });
    const { prompt, aspect_ratio } = req.body || {};
    console.log(`[Freepik Generate] Prompt: ${prompt ? prompt.substring(0, 80) : 'none'}, Aspect: ${aspect_ratio}`);
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    console.log(`[Freepik Generate] Posting to ${FREEPIK_API_URL}...`);
    const resp = await fetch(FREEPIK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-freepik-api-key': apiKey
      },
      body: JSON.stringify({ prompt, aspect_ratio }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    console.log(`[Freepik Generate] Initial response status: ${resp.status}`);
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[Freepik Generate] Freepik API error ${resp.status}: ${text.substring(0, 200)}`);
      
      // Detect quota/rate limit errors and provide helpful message
      if (resp.status === 429) {
        const errorMsg = 'Freepik API quota exceeded (free trial limit reached). Upgrade your plan or use a new API key.';
        console.error(`[Freepik Generate] Quota error detected: ${errorMsg}`);
        return res.status(429).json({ error: errorMsg, quota_exceeded: true });
      }
      
      return res.status(502).json({ error: `Freepik error ${resp.status}: ${text}` });
    }
    const result = await resp.json();
    console.log(`[Freepik Generate] Response has task_id: ${result?.data?.task_id}, status: ${result?.data?.status}`);
    if (result?.data?.task_id && result?.data?.status === 'CREATED') {
      const url = await pollFreepikTask(result.data.task_id, apiKey);
      console.log(`[Freepik Generate] Poll completed, returning URL`);
      return res.json({ url });
    }
    const direct = result?.data?.url || result?.data?.image_url || result?.url || null;
    console.log(`[Freepik Generate] Returning direct URL: ${direct ? direct.substring(0, 100) : 'null'}`);
    return res.json({ url: direct });
  } catch (e) {
    console.error(`[Freepik Generate] Exception: ${e.message}`);
    return res.status(500).json({ error: e.message || 'Freepik proxy failure' });
  }
});

// Freepik debug endpoint to verify configuration
app.get('/api/freepik/debug', async (req, res) => {
  const hasKey = !!process.env.FREEPIK_API_KEY;
  const keyTail = hasKey ? process.env.FREEPIK_API_KEY.slice(-6) : null;
  // do a quick dry-run validation (no network call) and echo expected url
  res.json({ hasKey, keyTail, endpoint: FREEPIK_API_URL });
});

app.listen(PORT, () => {
  console.log(`AI backend listening on http://localhost:${PORT}`);
});


