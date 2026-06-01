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
    // userId приходит как query-параметр: /api/profile?userId=xxx
    const userId = req.query.userId || (req.body && req.body.userId);
    if (!userId) {
      return res.status(400).json({ ok: false, error: 'userId required' });
    }

    // Читаем три блока данных
    const profile = await redis.get('user:' + userId + ':profile');
    const stats = await redis.get('user:' + userId + ':stats');
    const streak = await redis.get('user:' + userId + ':streak');

    // Значения по умолчанию если данных ещё нет
    const p = profile || {};
    const s = stats || {};
    const st = streak || {};

    const totalMessages = s.messages || 0;
    const correctMessages = s.correct || 0;
    // процент корректности
    const correctness = totalMessages > 0 
      ? Math.round((correctMessages / totalMessages) * 100) 
      : 0;

    // сколько дней с регистрации
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
