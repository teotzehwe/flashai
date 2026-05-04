import mammoth from 'mammoth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY || process.env.GeminiAPIKey;
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

  // Build OpenRouter message content
  let messages;
  const isImage = type === 'file' && ['image/jpeg','image/jpg','image/png','image/gif','image/webp'].includes((mimeType || '').toLowerCase());
  const model = isImage
    ? 'meta-llama/llama-3.2-11b-vision-instruct:free'
    : 'meta-llama/llama-3.3-70b-instruct:free';

  try {
    if (type === 'topic') {
      messages = [{ role: 'user', content: `${instruction}\n\nTopic: ${content}` }];

    } else if (type === 'notes') {
      messages = [{ role: 'user', content: `${instruction}\n\nNotes:\n${content}` }];

    } else if (type === 'file') {
      const mime = (mimeType || '').toLowerCase();

      if (['image/jpeg','image/jpg','image/png','image/gif','image/webp'].includes(mime)) {
        const safeMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
        messages = [{
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: `data:${safeMime};base64,${content}` } }
          ]
        }];

      } else if (mime === 'application/pdf') {
        // Send PDF as image to vision model — OpenRouter accepts data URIs
        messages = [{
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: `data:application/pdf;base64,${content}` } }
          ]
        }];

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
        messages = [{ role: 'user', content: `${instruction}\n\nContent from "${fileName}":\n${result.value.trim()}` }];

      } else if (
        mime.startsWith('text/') ||
        ['application/json','application/javascript','application/xml'].includes(mime) ||
        /\.(txt|md|html|htm|csv|json|xml|yaml|yml|js|ts|py|java|c|cpp|css|rtf)$/i.test(fileName || '')
      ) {
        const text = Buffer.from(content, 'base64').toString('utf-8');
        if (!text.trim()) return res.status(400).json({ error: 'The file appears to be empty.' });
        messages = [{ role: 'user', content: `${instruction}\n\nContent from "${fileName}":\n${text.trim()}` }];

      } else {
        // Try as plain text fallback
        try {
          const text = Buffer.from(content, 'base64').toString('utf-8');
          messages = [{ role: 'user', content: `${instruction}\n\nContent from "${fileName}":\n${text.trim()}` }];
        } catch {
          return res.status(400).json({ error: `Unsupported file type: ${mime || fileName}` });
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid request type.' });
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://flashais.vercel.app',
        'X-Title': 'FlashAI'
      },
      body: JSON.stringify({ model, messages, max_tokens: 4096 })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err.error?.message || `OpenRouter API error (${response.status})`
      });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return res.status(500).json({ error: 'Empty response from model.' });

    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr);
    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
}
