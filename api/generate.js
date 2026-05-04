import mammoth from 'mammoth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  // Explicitly parse body — Vercel doesn't auto-parse for plain serverless functions
  let body = req.body;
  if (!body || typeof body === 'string' || Object.keys(body).length === 0) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Could not parse request body.' });
    }
  }

  const { content, type, mimeType, fileName, numCards, difficulty } = body;

  if (!numCards || !difficulty) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const instruction = `Generate exactly ${numCards} flashcards at ${difficulty} level from the provided content.
Return ONLY valid JSON — no extra text, no markdown fences:
{"cards": [{"question": "...", "answer": "...", "options": ["correct answer", "wrong1", "wrong2", "wrong3"]}]}
IMPORTANT: options[0] MUST be the correct answer. Make wrong options plausible but clearly incorrect.`;

  // Build Gemini "parts" array
  let parts;

  try {
    if (type === 'topic') {
      parts = [{ text: `${instruction}\n\nTopic: ${content}` }];

    } else if (type === 'notes') {
      parts = [{ text: `${instruction}\n\nNotes:\n${content}` }];

    } else if (type === 'file') {
      const mime = (mimeType || '').toLowerCase();

      if (mime === 'application/pdf') {
        parts = [
          { inline_data: { mime_type: 'application/pdf', data: content } },
          { text: instruction }
        ];

      } else if (['image/jpeg','image/jpg','image/png','image/gif','image/webp'].includes(mime)) {
        const safeMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
        parts = [
          { inline_data: { mime_type: safeMime, data: content } },
          { text: instruction }
        ];

      } else if (
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mime === 'application/msword' ||
        (fileName || '').toLowerCase().endsWith('.docx') ||
        (fileName || '').toLowerCase().endsWith('.doc')
      ) {
        const buffer = Buffer.from(content, 'base64');
        const result = await mammoth.extractRawText({ buffer });
        if (!result.value.trim()) {
          return res.status(400).json({ error: 'Could not extract text from this Word document.' });
        }
        parts = [{ text: `${instruction}\n\nContent from "${fileName}":\n${result.value.trim()}` }];

      } else if (
        mime.startsWith('text/') ||
        ['application/json','application/javascript','application/xml'].includes(mime) ||
        /\.(txt|md|html|htm|csv|json|xml|yaml|yml|js|ts|py|java|c|cpp|css|rtf)$/i.test(fileName || '')
      ) {
        const text = Buffer.from(content, 'base64').toString('utf-8');
        if (!text.trim()) return res.status(400).json({ error: 'The file appears to be empty.' });
        parts = [{ text: `${instruction}\n\nContent from "${fileName}":\n${text.trim()}` }];

      } else if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(fileName || '')) {
        const audioMime = mime.startsWith('audio/') ? mime : 'audio/mpeg';
        parts = [
          { inline_data: { mime_type: audioMime, data: content } },
          { text: instruction }
        ];

      } else if (mime.startsWith('video/') || /\.(mp4|mov|avi|webm|mkv|m4v)$/i.test(fileName || '')) {
        const videoMime = mime.startsWith('video/') ? mime : 'video/mp4';
        parts = [
          { inline_data: { mime_type: videoMime, data: content } },
          { text: instruction }
        ];

      } else {
        try {
          const text = Buffer.from(content, 'base64').toString('utf-8');
          parts = [{ text: `${instruction}\n\nContent from "${fileName}":\n${text.trim()}` }];
        } catch {
          return res.status(400).json({ error: `Unsupported file type: ${mime || fileName}` });
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid request type.' });
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { maxOutputTokens: 4096 }
        })
      }
    );

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err.error?.message || `Gemini API error (${response.status})`
      });
    }

    const data = await response.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!raw) return res.status(500).json({ error: 'Empty response from Gemini.' });

    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr);
    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
}
