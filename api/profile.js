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
    // tgId приходит как query-параметр: /api/profile?tgId=12345
    const tgId = req.query.tgId || (req.body && req.body.tgId);
    if (!tgId) {
      return res.status(400).json({ ok: false, error: 'tgId required' });
    }

    const key = 'tg:' + tgId;
    const profile = await redis.get(key + ':profile');
    const stats = await redis.get(key + ':stats');
    const streak = await redis.get(key + ':streak');

    const p = profile || {};
    const s = stats || {};
    const st = streak || {};

    const totalMessages = s.messages || 0;
    const correctMessages = s.correct || 0;
    const correctness = totalMessages > 0 ? Math.round((correctMessages / totalMessages) * 100) : 0;

    let daysSinceStart = 0;
    if (p.startDate) {
      const start = new Date(p.startDate);
      const now = new Date();
      daysSinceStart = Math.max(1, Math.ceil((now - start) / (1000 * 60 * 60 * 24)));
    }

    return res.status(200).json({
      ok: true,
      name: p.name || 'Друг',
      level: p.level || 'beginner',
      startDate: p.startDate || null,
      daysSinceStart: daysSinceStart,
      streak: st.current || 0,
      maxStreak: st.max || 0,
      messages: totalMessages,
      words: s.words || 0,
      correctness: correctness
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
