import { Redis } from '@upstash/redis';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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
        text: text,
      }),
    });
    return r.ok;
  } catch (e) {
    console.error('Telegram notify failed:', tgId, e.message);
    return false;
  }
}

export default async function handler(req, res) {
  // ============================================================
  // ВЕТКА 1: Keep-warm mode (вызывается внешним cron'ом каждые 5 мин)
  // ============================================================
  // Botpress отбрасывает сообщения, которые бот шлёт сам себе (is_bot:true),
  // поэтому раньше __ping__ не доходил до Standard3 и коннектор не прогревался.
  //
  // Новая схема: используем второй личный Telegram-аккаунт через GramJS
  // (User API). Он шлёт боту обычное сообщение "__ping__" — для Botpress это
  // выглядит как сообщение от настоящего юзера, оно проходит через Standard3,
  // ловится guard'ом (if userMessage === '__ping__') и тихо возвращается.
  // Этого хватает, чтобы коннектор и backend Botpress оставались тёплыми.
  //
  // Эндпоинт: GET /api/cron-reminders?action=warm
  //          Header: x-keepwarm-secret: <KEEPWARM_SECRET>
  if (req.query && req.query.action === 'warm') {
    const expected = process.env.KEEPWARM_SECRET;
    if (!expected) {
      return res.status(500).json({ ok: false, error: 'KEEPWARM_SECRET not configured' });
    }
    const provided = req.headers['x-keepwarm-secret'] || (req.query && req.query.secret);
    if (provided !== expected) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const apiIdRaw = process.env.TG_USER_API_ID;
    const apiHash = process.env.TG_USER_API_HASH;
    const sessionString = process.env.TG_USER_SESSION;
    const botUsername = process.env.BOT_USERNAME || 'PromptlyEnglishbot';

    if (!apiIdRaw || !apiHash || !sessionString) {
      return res.status(500).json({
        ok: false,
        error: 'TG_USER_API_ID / TG_USER_API_HASH / TG_USER_SESSION not configured',
      });
    }

    const apiId = parseInt(apiIdRaw, 10);
    if (!apiId) {
      return res.status(500).json({ ok: false, error: 'TG_USER_API_ID is not a number' });
    }

    let client = null;
    try {
      client = new TelegramClient(
        new StringSession(sessionString),
        apiId,
        apiHash,
        { connectionRetries: 2 }
      );
      await client.connect();
      await client.sendMessage(botUsername, { message: '__ping__' });
      await client.disconnect();
      return res.status(200).json({
        ok: true,
        mode: 'warm',
        via: 'user-api',
        pingedAt: new Date().toISOString(),
      });
    } catch (e) {
      try { if (client) await client.disconnect(); } catch (_) {}
      console.error('Keep-warm via user API failed:', e && e.message);
      return res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  }

  // ============================================================
  // ВЕТКА 2: обычные напоминания (Vercel Cron, раз в день)
  // ============================================================
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
          if (inactiveMs < ONE_DAY_MS) { summary.skipped++; continue; }

          // Don't re-remind within 1 day of last reminder
          if (lastReminder && (now - parseInt(lastReminder, 10)) < ONE_DAY_MS) {
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
