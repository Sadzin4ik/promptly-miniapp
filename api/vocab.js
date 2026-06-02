import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const tgId = req.query.tgId || (req.body && req.body.tgId);
    if (!tgId) return res.status(400).json({ ok: false, error: 'tgId required' });

    const key = 'tg:' + tgId + ':vocab';
    let vocab = await redis.get(key);
    if (!Array.isArray(vocab)) vocab = [];

    // сколько слов готовы к повторению сейчас
    const now = Date.now();
    const dueCount = vocab.filter(w => (w.nextReview || 0) <= now).length;

    return res.status(200).json({
      ok: true,
      total: vocab.length,
      due: dueCount,
      words: vocab
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
