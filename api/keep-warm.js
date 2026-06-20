// api/keep-warm.js
// Эндпоинт-прослойка для пинга Telegram-бота каждые 5 минут.
// Цель — держать тёплым входящий коннектор Telegram → Botpress
// (Botpress подтвердил, что Always Alive не покрывает этот коннектор,
// и предложил этот воркэраунд до выпуска фикса).
//
// Защита: вызов разрешён только при наличии заголовка x-keepwarm-secret
// (или ?secret=... в URL), значение которого совпадает с KEEPWARM_SECRET
// в Environment Variables Vercel.
//
// Что делает:
//  1. Отправляет в чат админа короткое служебное сообщение "__ping__"
//  2. Стандартное сообщение проходит через коннектор Botpress
//     и тем самым его "прогревает"
//  3. Standard3 распознаёт текст "__ping__" и сразу выходит (см. правку
//     в standard3.js: первая же проверка после получения userMessage)

export default async function handler(req, res) {
  // 1. Защита от случайных/чужих вызовов
  const provided = req.headers['x-keepwarm-secret'] || (req.query && req.query.secret);
  const expected = process.env.KEEPWARM_SECRET;
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'KEEPWARM_SECRET not configured' });
  }
  if (provided !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // 2. Конфигурация
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.ADMIN_ID || '8977716346';
  if (!token) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN missing' });
  }

  // 3. Отправляем служебный пинг боту от имени бота на чат админа.
  //    Standard3 распознаёт "__ping__" и сразу прекратит обработку,
  //    но коннектор успеет получить и обработать апдейт = прогреется.
  try {
    const tgRes = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: String(adminId),
        text: '__ping__',
        disable_notification: true
      })
    });

    const data = await tgRes.json();
    if (!data.ok) {
      return res.status(502).json({ ok: false, telegram: data });
    }

    // Удаляем пинг-сообщение сразу же, чтобы не засорять чат админа.
    // Это не критично для прогрева — главное, что коннектор уже получил апдейт.
    try {
      await fetch('https://api.telegram.org/bot' + token + '/deleteMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: String(adminId),
          message_id: data.result.message_id
        })
      });
    } catch (_) { /* не критично если не удалилось */ }

    return res.status(200).json({ ok: true, pingedAt: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
}
