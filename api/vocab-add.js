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
    // принимаем и GET (через query) и POST (через body)
    const src = req.method === 'POST' ? (req.body || {}) : req.query;
    const tgId = src.tgId;
    const word = (src.word || '').toString().trim().toLowerCase();
    const translation = (src.translation || '').toString().trim();
    const phonetic = (src.phonetic || '').toString().trim();

    if (!tgId) return res.status(400).json({ ok: false, error: 'tgId required' });
    if (!word) return res.status(400).json({ ok: false, error: 'word required' });

    const key = 'tg:' + tgId + ':vocab';
    let vocab = await redis.get(key);
    if (!Array.isArray(vocab)) vocab = [];

    // проверка дубликата
    const exists = vocab.find(w => w.word === word);
    if (exists) {
      return res.status(200).json({ ok: true, added: false, message: 'already exists', total: vocab.length });
    }

    // новое слово: первое повторение завтра
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    vocab.push({
      word: word,
      translation: translation,
      phonetic: phonetic,
      added: Date.now(),
      nextReview: tomorrow,
      interval: 1,      // дней
      reps: 0,          // сколько раз успешно повторил
      status: 'new'     // new | learning | learned
    });

    await redis.set(key, vocab);
    return res.status(200).json({ ok: true, added: true, total: vocab.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
