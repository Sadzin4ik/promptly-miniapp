import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function dayLabel(n) {
  if (n === 1) return '1 день';
  if (n >= 2 && n <= 4) return n + ' дня';
  return n + ' дней';
}

async function notifyExpiry(tgId, token, daysLeft) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(tgId),
        text:
          '⏳ Твоя <b>Premium-подписка</b> заканчивается через ' + dayLabel(daysLeft) + '.\n\n' +
          'Чтобы продолжить общение без ограничений — отправь /premium и выбери удобный тариф 👇',
        parse_mode: 'HTML',
      }),
    });
    return r.ok;
  } catch (e) {
    console.error('Telegram expiry notify failed:', tgId, e.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const auth = req.headers.authorization || '';
  if (auth !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN missing' });
  }

  const now = Date.now();
  const summary = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  let cursor = 0;

  try {
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: 'tg:*:sub', count: 100 });
      cursor = parseInt(nextCursor, 10) || 0;

      for (const key of keys) {
        summary.scanned++;
        const m = key.match(/^tg:(\d+):sub$/);
        if (!m) continue;
        const tgId = m[1];

        try {
          const sub = await redis.get(key);
          if (!sub || !sub.active || !sub.until) { summary.skipped++; continue; }

          const untilMs = new Date(sub.until).getTime();
          const msLeft = untilMs - now;

          // Warn only if 1-2 days remain (exclusive of 0 or already expired)
          if (msLeft <= 0 || msLeft > 2 * ONE_DAY_MS) { summary.skipped++; continue; }

          // Don't re-send for the same `until` value (one warning per subscription period)
          const lastWarned = await redis.get('tg:' + tgId + ':expiryWarned');
          if (lastWarned === sub.until) { summary.skipped++; continue; }

          const daysLeft = Math.max(1, Math.ceil(msLeft / ONE_DAY_MS));
          const sent = await notifyExpiry(tgId, botToken, daysLeft);
          if (sent) {
            await redis.set('tg:' + tgId + ':expiryWarned', sub.until);
            summary.sent++;
          } else {
            summary.errors++;
          }
        } catch (userErr) {
          summary.errors++;
          console.error('User error:', tgId, userErr.message);
        }
      }
    } while (cursor !== 0);

    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, ...summary });
  }
}
