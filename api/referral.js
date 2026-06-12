import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const MAX_REWARDED = 3;
const INVITEE_DAYS = 14;
const INVITER_DAYS = 7;

async function grantDays(tgId, days, planLabel) {
  const subKey = 'tg:' + tgId + ':sub';
  const existing = await redis.get(subKey);
  const now = Date.now();
  let base = now;
  let keepPlan = null;
  if (existing && existing.until) {
    const u = new Date(existing.until).getTime();
    if (u > now) { base = u; keepPlan = existing.plan; } // stack on top of active sub
  }
  const until = new Date(base + days * 86400000).toISOString();
  await redis.set(subKey, {
    active: true,
    plan: keepPlan || planLabel,
    until: until,
    source: 'referral',
  });
  return until;
}

async function notify(tgId, token, text) {
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(tgId), text: text, parse_mode: 'HTML' }),
    });
  } catch (e) { console.error('notify failed', tgId, e.message); }
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST required' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const inviterId = String(body.inviterId || '');
    const inviteeId = String(body.inviteeId || '');
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!/^\d+$/.test(inviterId) || !/^\d+$/.test(inviteeId)) {
      return res.status(200).json({ ok: false, reason: 'invalid ids' });
    }
    if (inviterId === inviteeId) {
      return res.status(200).json({ ok: false, reason: 'self referral' });
    }

    // Invitee must be new and not already referred
    const alreadyReferred = await redis.get('tg:' + inviteeId + ':referredBy');
    if (alreadyReferred) return res.status(200).json({ ok: false, reason: 'already referred' });

    const joinedAt = await redis.get('tg:' + inviteeId + ':joinedAt');
    if (joinedAt) return res.status(200).json({ ok: false, reason: 'invitee not new' });

    // Lock invitee so this can't be repeated
    await redis.set('tg:' + inviteeId + ':referredBy', inviterId);

    // Inviter must have an active PAID subscription to use referrals (closes the chain loophole:
    // premium received via referral or grant does NOT grant the right to invite further)
    const PAID_PLANS = ['month', 'quarter', 'year'];
    const inviterSub = await redis.get('tg:' + inviterId + ':sub');
    const inviterHasPaid = inviterSub && inviterSub.active && inviterSub.until &&
      new Date(inviterSub.until) > new Date() && PAID_PLANS.includes(inviterSub.plan);

    if (!inviterHasPaid) {
      // No rewards. Tell the invitee politely, nudge the inviter to buy.
      await notify(inviteeId, token,
        '👋 Привет! Тебя пригласили в Promptly.\n\nК сожалению, бонус по приглашению сейчас не активен. Но ты всё равно можешь попробовать бота бесплатно — 3 дня без ограничений, потом 7 сообщений в день. А если захочешь больше — оформи Premium через /premium 🚀'
      );
      await notify(inviterId, token,
        '👋 По твоей ссылке пришёл друг — здорово!\n\nНо бонусы за приглашения доступны только при <b>купленной</b> Premium-подписке (бонусная или подарочная не считается). Оформить можно через /premium 💎'
      );
      return res.status(200).json({ ok: false, reason: 'inviter_not_paid' });
    }

    // Invitee gets the welcome bonus
    const inviteeUntil = await grantDays(inviteeId, INVITEE_DAYS, 'referral_welcome');
    await notify(inviteeId, token,
      '🎁 <b>Тебе подарили 2 недели Premium!</b>\n\n' +
      'Друг пригласил тебя в Promptly — и ты получаешь полный доступ ко всем возможностям до <b>' + fmtDate(inviteeUntil) + '</b>.\n\n' +
      'Общайся без ограничений — голосом и текстом. Удачи! 🚀'
    );

    // Inviter rewarded only up to the cap
    const rewardedRaw = await redis.get('tg:' + inviterId + ':refCount');
    const rewarded = rewardedRaw ? parseInt(rewardedRaw, 10) : 0;
    let inviterRewarded = false;
    if (rewarded < MAX_REWARDED) {
      await redis.incr('tg:' + inviterId + ':refCount');
      const inviterUntil = await grantDays(inviterId, INVITER_DAYS, 'referral_bonus');
      inviterRewarded = true;
      await notify(inviterId, token,
        '🎉 <b>Твой друг присоединился к Promptly!</b>\n\n' +
        'Тебе начислена <b>+1 неделя Premium</b>. Подписка активна до <b>' + fmtDate(inviterUntil) + '</b>.\n\n' +
        'Спасибо, что делишься! 🙌'
      );
    }

    return res.status(200).json({ ok: true, inviteeUntil: inviteeUntil, inviterRewarded: inviterRewarded });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
