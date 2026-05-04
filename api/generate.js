import mammoth from 'mammoth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const { content, type, mimeType, fileName, numCards, difficulty } = req.body;

  if (!numCards || !difficulty) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const instruction = `Generate exactly ${numCards} flashcards at ${difficulty} level from the provided content.
Return ONLY valid JSON — no extra text, no markdown fences:
{"cards": [{"question": "...", "answer": "...", "options": ["correct answer", "wrong1", "wrong2", "wrong3"]}]}
IMPORTANT: options[0] MUST be the correct answer. Make wrong options plausible but clearly incorrect.`;

  let messages;
  const extraHeaders = {};

  try {
    if (type === 'topic') {
      messages = [{ role: 'user', content: `${instruction}\n\nTopic: ${content}` }];

    } else if (type === 'notes') {
      messages = [{ role: 'user', content: `${instruction}\n\nNotes:\n${content}` }];

    } else if (type === 'file') {
      const mime = (mimeType || '').toLowerCase();

      if (mime === 'application/pdf') {
        extraHeaders['anthropic-beta'] = 'pdfs-2024-09-25';
        messages = [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: content } },
            { type: 'text', text: instruction }
          ]
        }];

      } else if (['image/jpeg','image/jpg','image/png','image/gif','image/webp'].includes(mime)) {
        const safeMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
        messages = [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: safeMime, data: content } },
            { type: 'text', text: instruction }
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
        messages = [{
          role: 'user',
          content: `${instruction}\n\nContent from "${fileName}":\n${result.value.trim()}`
        }];

      } else if (
        mime.startsWith('text/') ||
        ['application/json','application/javascript','application/xml'].includes(mime) ||
        /\.(txt|md|html|htm|csv|json|xml|yaml|yml|js|ts|py|java|c|cpp|css|rtf)$/i.test(fileName || '')
      ) {
        const text = Buffer.from(content, 'base64').toString('utf-8');
        if (!text.trim()) return res.status(400).json({ error: 'The file appears to be empty.' });
        messages = [{
          role: 'user',
          content: `${instruction}\n\nContent from "${fileName}":\n${text.trim()}`
        }];

      } else if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|aac|flac)$/i.test(fileName || '')) {
        const audioMime = mime.startsWith('audio/') ? mime : 'audio/mpeg';
        messages = [{
          role: 'user',
          content: [
            { type: 'audio', source: { type: 'base64', media_type: audioMime, data: content } },
            { type: 'text', text: instruction }
          ]
        }];

      } else if (mime.startsWith('video/') || /\.(mp4|mov|avi|webm|mkv|m4v)$/i.test(fileName || '')) {
        const videoMime = mime.startsWith('video/') ? mime : 'video/mp4';
        messages = [{
          role: 'user',
          content: [
            { type: 'video', source: { type: 'base64', media_type: videoMime, data: content } },
            { type: 'text', text: instruction }
          ]
        }];

      } else {
        try {
          const text = Buffer.from(content, 'base64').toString('utf-8');
          messages = [{
            role: 'user',
            content: `${instruction}\n\nContent from "${fileName}":\n${text.trim()}`
          }];
        } catch {
          return res.status(400).json({ error: `Unsupported file type: ${mime || fileName}` });
        }
      }
    } else {
      return res.status(400).json({ error: 'Invalid request type.' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...extraHeaders
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 4096,
        messages
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: err.error?.message || `Claude API error (${response.status})`
      });
    }

    const data = await response.json();
    const raw = data.content[0].text.trim();
    const jsonStr = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr);
    return res.status(200).json(parsed);

  } catch (e) {
    return res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
}
