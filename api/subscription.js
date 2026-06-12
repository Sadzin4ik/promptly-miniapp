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

    const [sub, refCountRaw] = await Promise.all([
      redis.get('tg:' + tgId + ':sub'),
      redis.get('tg:' + tgId + ':refCount'),
    ]);
    const refCount = refCountRaw ? parseInt(refCountRaw, 10) : 0;

    if (!sub || !sub.active || !sub.until) {
      return res.status(200).json({ ok: true, active: false, refCount: refCount });
    }

    const now = new Date();
    const until = new Date(sub.until);
    const isActive = until > now;
    const daysLeft = isActive ? Math.ceil((until - now) / (1000 * 60 * 60 * 24)) : 0;

    return res.status(200).json({
      ok: true,
      active: isActive,
      plan: sub.plan || null,
      until: isActive ? sub.until : null,
      daysLeft: daysLeft,
      refCount: refCount
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
