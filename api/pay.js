import { randomUUID } from 'crypto';

const TARIFFS = {
  month:   { amount: '690.00',  description: 'Promptly Premium — 1 месяц',  days: 30  },
  quarter: { amount: '1767.00', description: 'Promptly Premium — 3 месяца', days: 90  },
  year:    { amount: '5388.00', description: 'Promptly Premium — 1 год',    days: 365 },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST required' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { tgId, plan } = body;

    if (!tgId || !plan) {
      return res.status(400).json({ ok: false, error: 'tgId and plan required' });
    }

    const tariff = TARIFFS[plan];
    if (!tariff) {
      return res.status(400).json({ ok: false, error: 'invalid plan (use month/quarter/year)' });
    }

    const shopId = process.env.YOOKASSA_SHOP_ID;
    const secretKey = process.env.YOOKASSA_SECRET_KEY;
    if (!shopId || !secretKey) {
      return res.status(500).json({ ok: false, error: 'YooKassa credentials not configured' });
    }

    const idempotenceKey = randomUUID();
    const authHeader = 'Basic ' + Buffer.from(shopId + ':' + secretKey).toString('base64');

    const payload = {
      amount: { value: tariff.amount, currency: 'RUB' },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: 'https://t.me/PromptlyEnglishbot'
      },
      description: tariff.description,
      metadata: {
        tgId: String(tgId),
        plan: plan,
        days: String(tariff.days)
      }
      // TODO: receipt object for самозанятый (ждём ответ поддержки ЮКассы)
    };

    const ykRes = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Idempotence-Key': idempotenceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const ykData = await ykRes.json();

    if (!ykRes.ok || !ykData.confirmation || !ykData.confirmation.confirmation_url) {
      return res.status(500).json({
        ok: false,
        error: 'YooKassa rejected the payment request',
        details: ykData
      });
    }

    return res.status(200).json({
      ok: true,
      paymentId: ykData.id,
      confirmationUrl: ykData.confirmation.confirmation_url,
      amount: tariff.amount,
      plan: plan
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
