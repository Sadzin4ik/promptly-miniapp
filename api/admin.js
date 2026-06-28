import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// ============================================================
// AUTH
// ============================================================
function checkAuth(req) {
  const ADMIN_SECRET = process.env.ADMIN_SECRET_KEY;
  const ADMIN_ID = process.env.ADMIN_ID || '8977716346';

  const key = req.query?.key || req.headers?.['x-admin-key'];
  if (key && ADMIN_SECRET && key === ADMIN_SECRET) return true;

  const initData = req.query?.initData || req.headers?.['x-init-data'];
  if (initData) {
    try {
      const params = new URLSearchParams(initData);
      const user = JSON.parse(params.get('user') || '{}');
      if (String(user.id) === String(ADMIN_ID)) return true;
    } catch (_) {}
  }

  return false;
}

// ============================================================
// MAIN
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-init-data');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!checkAuth(req)) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const action = req.query.action;
  if (!action) return res.status(400).json({ ok: false, error: 'action required' });

  try {
    if (action === 'stats')  return await actStats(req, res);
    if (action === 'users')  return await actUsers(req, res);
    if (action === 'user')   return await actUser(req, res);
    if (action === 'events') return await actEvents(req, res);
    if (action === 'do')     return await actDo(req, res);
    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('[admin]', action, 'error:', e && e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ============================================================
// STATS — Dashboard
// ============================================================
async function actStats(req, res) {
  const allUsers = await redis.smembers('users:all');
  const usersTotal = allUsers.length;

  const today = new Date().toISOString().slice(0, 10);
  const activeTodayIds = await redis.smembers('active:' + today);
  const activeToday = activeTodayIds.length;

  const activeWeekSet = new Set();
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const ids = await redis.smembers('active:' + d);
    ids.forEach(id => activeWeekSet.add(id));
  }
  const activeWeek = activeWeekSet.size;

  const dailyActivity = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const ids = await redis.smembers('active:' + d);
    dailyActivity.push({ date: d, count: ids.length });
  }

  let paidCount = 0;
  let activeSubsCount = 0;
  const now = new Date();
  for (const tgId of allUsers) {
    const sub = await redis.get('tg:' + tgId + ':sub');
    if (sub && sub.active && sub.until && new Date(sub.until) > now) {
      activeSubsCount++;
      if (['month', 'quarter', 'year'].includes(sub.plan)) paidCount++;
    }
  }

  let messagesToday = 0;
  for (const tgId of allUsers) {
    const count = await redis.get('tg:' + tgId + ':msgs:' + today);
    messagesToday += count ? Number(count) : 0;
  }

  return res.status(200).json({
    ok: true,
    stats: { usersTotal, activeToday, activeWeek, paidCount, activeSubsCount, messagesToday },
    dailyActivity,
  });
}

// ============================================================
// USERS — список юзеров
// ============================================================
async function actUsers(req, res) {
  const allUsers = await redis.smembers('users:all');

  const users = await Promise.all(allUsers.map(async (tgId) => {
    const [profile, meta, stats, streak, sub, lastActive, joinedAt, banned] = await Promise.all([
      redis.get('tg:' + tgId + ':profile'),
      redis.get('tg:' + tgId + ':meta'),
      redis.get('tg:' + tgId + ':stats'),
      redis.get('tg:' + tgId + ':streak'),
      redis.get('tg:' + tgId + ':sub'),
      redis.get('tg:' + tgId + ':lastActive'),
      redis.get('tg:' + tgId + ':joinedAt'),
      redis.get('tg:' + tgId + ':banned'),
    ]);

    const p = profile || {};
    const m = meta || {};
    const s = stats || { messages: 0, words: 0, correct: 0 };
    const st = streak || { current: 0, max: 0 };

    let subActive = false;
    let subUntil = null;
    if (sub && sub.active && sub.until && new Date(sub.until) > new Date()) {
      subActive = true;
      subUntil = sub.until;
    }

    return {
      tgId,
      name: p.name || m.first_name || '—',
      username: m.username || '',
      level: p.level || 'beginner',
      messages: s.messages || 0,
      words: s.words || 0,
      streak: st.current || 0,
      lastActive: lastActive ? Number(lastActive) : null,
      joinedAt: joinedAt ? Number(joinedAt) : null,
      subActive,
      subPlan: sub?.plan || null,
      subUntil,
      banned: !!banned,
    };
  }));

  users.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  return res.status(200).json({ ok: true, users });
}

// ============================================================
// USER — детали одного юзера
// ============================================================
async function actUser(req, res) {
  const tgId = req.query.tgId;
  if (!tgId) return res.status(400).json({ ok: false, error: 'tgId required' });

  const [
    profile, meta, stats, streak, sub, lastActive, joinedAt, banned,
    historyFull, refCount, referredBy
  ] = await Promise.all([
    redis.get('tg:' + tgId + ':profile'),
    redis.get('tg:' + tgId + ':meta'),
    redis.get('tg:' + tgId + ':stats'),
    redis.get('tg:' + tgId + ':streak'),
    redis.get('tg:' + tgId + ':sub'),
    redis.get('tg:' + tgId + ':lastActive'),
    redis.get('tg:' + tgId + ':joinedAt'),
    redis.get('tg:' + tgId + ':banned'),
    redis.lrange('tg:' + tgId + ':history:full', 0, -1),
    redis.get('tg:' + tgId + ':refCount'),
    redis.get('tg:' + tgId + ':referredBy'),
  ]);

  const last7Msgs = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const count = await redis.get('tg:' + tgId + ':msgs:' + d);
    last7Msgs.push({ date: d, count: count ? Number(count) : 0 });
  }

  const parsedHistory = (historyFull || []).map(item => {
    try { return typeof item === 'string' ? JSON.parse(item) : item; }
    catch (_) { return { role: 'unknown', text: String(item), ts: 0 }; }
  });

  return res.status(200).json({
    ok: true,
    user: {
      tgId,
      profile: profile || {},
      meta: meta || {},
      stats: stats || { messages: 0, words: 0, correct: 0 },
      streak: streak || { current: 0, max: 0, lastDay: null },
      sub: sub || null,
      lastActive: lastActive ? Number(lastActive) : null,
      joinedAt: joinedAt ? Number(joinedAt) : null,
      banned: !!banned,
      refCount: refCount ? Number(refCount) : 0,
      referredBy: referredBy || null,
    },
    history: parsedHistory,
    last7Msgs,
  });
}

// ============================================================
// EVENTS — лента событий
// ============================================================
async function actEvents(req, res) {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const raw = await redis.zrange('events:global', 0, limit - 1, { rev: true });
  const events = (raw || []).map(item => {
    try { return typeof item === 'string' ? JSON.parse(item) : item; }
    catch (_) { return null; }
  }).filter(Boolean);
  return res.status(200).json({ ok: true, events });
}

// ============================================================
// DO — действия (ban/unban/grant/revoke/reset_daily/clear_history/delete_all)
// ============================================================
async function actDo(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { type, tgId } = body;
  if (!type || !tgId) return res.status(400).json({ ok: false, error: 'type and tgId required' });

  if (type === 'ban') {
    await redis.set('tg:' + tgId + ':banned', '1');
    return res.status(200).json({ ok: true, type, tgId });
  }
  if (type === 'unban') {
    await redis.del('tg:' + tgId + ':banned');
    return res.status(200).json({ ok: true, type, tgId });
  }
  if (type === 'grant') {
    const days = Number(body.days);
    const plan = body.plan || 'gift';
    if (!days || days < 1 || days > 3650) {
      return res.status(400).json({ ok: false, error: 'invalid days' });
    }
    const existing = await redis.get('tg:' + tgId + ':sub');
    const now = Date.now();
    let base = now;
    if (existing && existing.until) {
      const u = new Date(existing.until).getTime();
      if (u > now) base = u;
    }
    const until = new Date(base + days * 86400000).toISOString();
    await redis.set('tg:' + tgId + ':sub', {
      active: true, plan, until, source: 'admin_panel',
      grantedAt: new Date().toISOString()
    });
    return res.status(200).json({ ok: true, type, tgId, until });
  }
  if (type === 'revoke') {
    await redis.del('tg:' + tgId + ':sub');
    return res.status(200).json({ ok: true, type, tgId });
  }
  if (type === 'reset_daily') {
    const today = new Date().toISOString().slice(0, 10);
    await redis.del('tg:' + tgId + ':msgs:' + today);
    return res.status(200).json({ ok: true, type, tgId });
  }
  if (type === 'clear_history') {
    await Promise.all([
      redis.del('tg:' + tgId + ':history'),
      redis.del('tg:' + tgId + ':history:full'),
    ]);
    return res.status(200).json({ ok: true, type, tgId });
  }
  if (type === 'delete_all') {
    const today = new Date().toISOString().slice(0, 10);
    const keys = [
      'profile', 'meta', 'stats', 'streak', 'sub', 'lastActive', 'joinedAt',
      'banned', 'remindersOff', 'refCount', 'referredBy', 'history', 'history:full',
      'msgs:' + today
    ];
    await Promise.all(keys.map(k => redis.del('tg:' + tgId + ':' + k)));
    await redis.srem('users:all', tgId);
    return res.status(200).json({ ok: true, type, tgId });
  }

  return res.status(400).json({ ok: false, error: 'unknown type' });
}
