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
    const src = req.method === 'POST' ? (req.body || {}) : req.query;
    const tgId = src.tgId;
    const word = (src.word || '').toString().trim().toLowerCase();
    const known = src.known === true || src.known === 'true'; // знаю / не знаю

    if (!tgId) return res.status(400).json({ ok: false, error: 'tgId required' });
    if (!word) return res.status(400).json({ ok: false, error: 'word required' });

    const key = 'tg:' + tgId + ':vocab';
    let vocab = await redis.get(key);
    if (!Array.isArray(vocab)) vocab = [];

    const w = vocab.find(x => x.word === word);
    if (!w) return res.status(404).json({ ok: false, error: 'word not found' });

    const DAY = 24 * 60 * 60 * 1000;

    if (known) {
      // знаю — интервал растёт (упрощённый SM-2)
      w.reps = (w.reps || 0) + 1;
      if (w.reps === 1) w.interval = 1;
      else if (w.reps === 2) w.interval = 3;
      else w.interval = Math.round((w.interval || 1) * 2.2);
      if (w.interval > 180) w.interval = 180; // потолок полгода
      w.nextReview = Date.now() + w.interval * DAY;
      // статус
      if (w.reps >= 4 && w.interval >= 30) w.status = 'learned';
      else w.status = 'learning';
    } else {
      // не знаю — сброс, вернётся сегодня (через ~10 минут)
      w.reps = 0;
      w.interval = 1;
      w.nextReview = Date.now() + 10 * 60 * 1000;
      w.status = 'learning';
    }

    await redis.set(key, vocab);
    return res.status(200).json({ ok: true, word: w });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
