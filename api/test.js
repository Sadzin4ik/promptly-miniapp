import { Redis } from '@upstash/redis';
 
const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});
 
export default async function handler(req, res) {
  // разрешаем доступ из браузера (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
 
  try {
    // увеличиваем счётчик на 1 при каждом заходе
    const count = await redis.incr('test:visits');
    // записываем время последнего захода
    await redis.set('test:last_visit', new Date().toISOString());
    const lastVisit = await redis.get('test:last_visit');
 
    return res.status(200).json({
      ok: true,
      message: 'Redis работает! 🎉',
      visits: count,
      lastVisit: lastVisit
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
 
