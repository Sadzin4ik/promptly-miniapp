export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  try {
    const body = req.body || {};
    const tgId = body.tgId;
    let text = (body.text || '').toString().trim();
    let question = (body.question || '').toString().trim();

    // базовая защита от абуза
    if (!tgId) return res.status(400).json({ ok: false, error: 'tgId required' });
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });
    if (text.length > 600) text = text.substring(0, 600);
    if (question.length > 300) question = question.substring(0, 300);

    const apiKey = process.env.OPENAI_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'OPENAI_KEY is not set in Vercel env' });

    const system =
      'You are a warm English tutor checking a learner reply. ' +
      (question ? ('The coach asked: "' + question.replace(/"/g, "'") + '". ') : '') +
      'Check ONLY real grammar/usage errors in their answer. RULES: ' +
      '1) Fix HOW it is said (grammar, tense, verb form, articles, prepositions, word order, spelling), NEVER change WHAT they mean. ' +
      '2) The -ing continuous form is CORRECT for actions happening now (I am sitting, I am talking). Only STATIVE verbs are wrong in -ing (taste, smell, see, hear, know, understand, want, need, like, love, prefer, own) - fix only those to the simple form. ' +
      '3) If the English is already correct and natural, do NOT invent errors. ' +
      '4) Do not flag punctuation or capitalization. ' +
      'Return ONLY raw JSON, no markdown: {"has_errors": boolean, "corrected": "their answer with errors fixed, or unchanged if none", "better": "a more natural native-like version, or empty string if already natural", "feedback": "1-2 short sentences in RUSSIAN: praise what is good and explain the main fix simply"}';

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text }
        ]
      })
    });

    const j = await r.json();
    if (!r.ok) return res.status(502).json({ ok: false, error: 'openai error', detail: j });

    const raw = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(200).json({ ok: true, has_errors: false, corrected: text, better: '', feedback: 'Не получилось разобрать ответ, попробуй ещё раз.' });
    }

    return res.status(200).json({
      ok: true,
      has_errors: !!parsed.has_errors,
      corrected: (parsed.corrected || text).toString(),
      better: (parsed.better || '').toString(),
      feedback: (parsed.feedback || '').toString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
