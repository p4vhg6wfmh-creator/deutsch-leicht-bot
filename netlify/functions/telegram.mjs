import { webhookCallback } from 'grammy';
import { getBot } from '../../src/bot.js';
import { ENV } from '../../src/config.js';

const bot = getBot();

const handle = webhookCallback(bot, 'std/http', {
  secretToken: ENV.WEBHOOK_SECRET || undefined,
  timeoutMilliseconds: 8_000,
});

export default async (request) => {
  try {
    return await handle(request);
  } catch (e) {
    // Telegram обязательно должен получить 200, иначе будет слать апдейт по кругу
    console.error('WEBHOOK ERROR', e);
    return new Response('ok', { status: 200 });
  }
};

export const config = { path: '/telegram' };
