import { Bot } from 'grammy';
import { ENV } from './config.js';
import { registerMenu } from './menu.js';
import { registerPayment } from './payment.js';
import { registerGroups } from './groups.js';
import { registerPractice } from './practice.js';
import * as db from './db.js';

let _bot = null;

export function getBot() {
  if (_bot) return _bot;

  const bot = new Bot(ENV.BOT_TOKEN);

  // Порядок важен: меню регистрирует команды, payment — обработчики сообщений
  registerMenu(bot);
  registerGroups(bot);
  registerPractice(bot);
  registerPayment(bot);

  bot.command('help', (ctx) =>
    ctx.reply('Напиши мне прямо сюда — я отвечу лично 🙌'),
  );

  // Служебное: узнать свой tg_id (для OWNER_TG_ID)
  bot.command('whoami', (ctx) => ctx.reply(`Твой tg_id: ${ctx.from.id}`));

  bot.catch(async (err) => {
    console.error('BOT ERROR', err.error ?? err);

    // Пользователь заблокировал бота — помечаем и не шумим
    const code = err.error?.error_code;
    if (code === 403 && err.ctx?.from) {
      const user = await db.getUserByTgId(err.ctx.from.id);
      if (user) await db.markBlocked(user.id);
      return;
    }

    if (ENV.ADMIN_CHAT_ID) {
      await err.ctx?.api
        .sendMessage(ENV.ADMIN_CHAT_ID, `⚠️ Ошибка бота:\n${String(err.error ?? err).slice(0, 500)}`)
        .catch(() => {});
    }
  });

  _bot = bot;
  return bot;
}
