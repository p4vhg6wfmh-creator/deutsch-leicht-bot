// Запуск:
//   BOT_TOKEN=... SITE_URL=https://твой-сайт.netlify.app WEBHOOK_SECRET=... node scripts/set-webhook.mjs
//   node scripts/set-webhook.mjs --delete    ← снять вебхук

const token  = process.env.BOT_TOKEN;
const site   = process.env.SITE_URL;
const secret = process.env.WEBHOOK_SECRET || '';

if (!token) {
  console.error('Нет BOT_TOKEN в переменных окружения');
  process.exit(1);
}

const api = (method, params) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  }).then((r) => r.json());

if (process.argv.includes('--delete')) {
  console.log(await api('deleteWebhook', { drop_pending_updates: true }));
  process.exit(0);
}

if (!site) {
  console.error('Нет SITE_URL');
  process.exit(1);
}

const url = `${site.replace(/\/$/, '')}/telegram`;

console.log(await api('setWebhook', {
  url,
  secret_token: secret || undefined,
  drop_pending_updates: true,
  allowed_updates: ['message', 'callback_query'],
}));

console.log(await api('getWebhookInfo'));
