import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// Official YooKassa webhook source IP ranges (https://yookassa.ru/developers/using-api/webhooks)
// We allow incoming requests only from these IPs.
const YOOKASSA_IPS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '2a02:5180::/32',
];

function ipInRange(ip, cidr) {
  if (!ip) return false;
  if (!cidr.includes('/')) return ip === cidr;
  // Simple IPv4 CIDR check (ignore IPv6 for now — Vercel forwards mostly IPv4)
  const [range, bits] = cidr.split('/');
  if (range.includes(':') || ip.includes(':')) return false; // skip IPv6
  const ipToInt = (s) => s.split('.').reduce((a, b) => (a << 8) + parseInt(b, 10), 0) >>> 0;
  const mask = bits === '32' ? 0xFFFFFFFF : (~0 << (32 - parseInt(bits, 10))) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(range) & mask);
}

function isYookassaIp(ip) {
  if (!ip) return false;
  return YOOKASSA_IPS.some((cidr) => ipInRange(ip, cidr));
}

async function notifyUser(tgId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(tgId), text: text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    // Don't crash the webhook if Telegram is down
    console.error('Telegram notify failed:', e.message);
  }
}

export default async function handler(req, res) {
  // YooKassa always uses POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST required' });
  }

  try {
    // Verify source IP
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = fwd || req.socket?.remoteAddress || '';
    if (!isYookassaIp(ip)) {
      console.warn('Webhook from unknown IP:', ip);
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const event = body.event;
    const payment = body.object;

    if (!event || !payment) {
      return res.status(400).json({ ok: false, error: 'invalid payload' });
    }

    // We only care about successful payments. Cancelled / waiting_for_capture etc — just ack and ignore.
    if (event !== 'payment.succeeded') {
      return res.status(200).json({ ok: true, ignored: event });
    }

    const meta = payment.metadata || {};
    const tgId = meta.tgId;
    const plan = meta.plan;
    const days = parseInt(meta.days, 10);

    if (!tgId || !plan || !days || days < 1) {
      console.error('Payment without proper metadata:', payment.id, meta);
      return res.status(200).json({ ok: true, error: 'missing metadata, manual review needed' });
    }

    // Extend existing subscription if any (don't reset days remaining)
    const subKey = 'tg:' + tgId + ':sub';
    const existing = await redis.get(subKey);
    const now = Date.now();
    let baseTime = now;
    if (existing && existing.until) {
      const existingUntil = new Date(existing.until).getTime();
      if (existingUntil > now) baseTime = existingUntil; // stack on top
    }
    const newUntil = new Date(baseTime + days * 86400000).toISOString();

    await redis.set(subKey, {
      active: true,
      plan: plan,
      until: newUntil,
      lastPaymentId: payment.id,
      lastPaymentAt: new Date(now).toISOString(),
      amount: payment.amount?.value || null,
    });

    // Notify user in Telegram
    const planNames = { month: '1 месяц', quarter: '3 месяца', year: '1 год' };
    const planName = planNames[plan] || plan;
    const untilStr = new Date(newUntil).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
    await notifyUser(
      tgId,
      '✅ <b>Premium активна!</b>\n\n' +
      'Тариф: ' + planName + '\n' +
      'Действует до: ' + untilStr + '\n\n' +
      'Спасибо! Теперь можно общаться без ограничений. 🎉'
    );

    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error('Webhook error:', e);
    // Return 200 anyway so YooKassa doesn't retry indefinitely for a bug on our side
    return res.status(200).json({ ok: false, error: e.message });
  }
}
