import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

// Light, varied English prompts — feel like a friend nudging, not a system
const MESSAGES = [
  "Hey 👋 Missed our chats! Let's practice some English today — even 5 minutes counts.",
  "What's the most interesting thing that happened to you yesterday? Tell me in English 🌟",
  "Quick warm-up: how's your day going? Drop me a voice or text message 🎤",
  "Ready to practice? Tell me about your weekend plans — even one sentence works 🗓️",
  "Hi! Let's keep your English flowing. What's on your mind today? 💬",
  "A few minutes of practice today = real progress this month. What's up? ✨",
];

async function notifyUser(tgId, token, text) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(tgId),
        text: text + '\n\n💤 Не хочешь напоминаний — отправь /stop',
      }),
    });
    return r.ok;
  } catch (e) {
    console.error('Telegram notify failed:', tgId, e.message);
    return false;
  }
}

export default async function handler(req, res) {
  // Authenticate: Vercel cron sends Authorization: Bearer CRON_SECRET
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
      const [nextCursor, keys] = await redis.scan(cursor, { match: 'tg:*:profile', count: 100 });
      cursor = parseInt(nextCursor, 10) || 0;

      for (const key of keys) {
        summary.scanned++;
        const m = key.match(/^tg:(\d+):profile$/);
        if (!m) continue;
        const tgId = m[1];

        try {
          const [lastActive, optOut, lastReminder] = await Promise.all([
            redis.get('tg:' + tgId + ':lastActive'),
            redis.get('tg:' + tgId + ':remindersOff'),
            redis.get('tg:' + tgId + ':lastReminder'),
          ]);

          if (optOut) { summary.skipped++; continue; }
          if (!lastActive) { summary.skipped++; continue; }

          const inactiveMs = now - parseInt(lastActive, 10);
          if (inactiveMs < TWO_DAYS_MS) { summary.skipped++; continue; }

          // Don't re-remind within 2 days of last reminder
          if (lastReminder && (now - parseInt(lastReminder, 10)) < TWO_DAYS_MS) {
            summary.skipped++; continue;
          }

          const msg = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
          const sent = await notifyUser(tgId, botToken, msg);
          if (sent) {
            await redis.set('tg:' + tgId + ':lastReminder', String(now));
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
