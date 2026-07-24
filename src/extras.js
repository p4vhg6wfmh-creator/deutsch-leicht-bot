import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { ENV } from './config.js';
import { escapeHtml, kbBackMain } from './ui.js';

// ---------------------------------------------------------------------
// Сегменты рассылки
// ---------------------------------------------------------------------
const SEGMENTS = {
  all:      'Всем',
  practice: 'Решают задания',
  waitlist: 'Лист ожидания',
  groups:   'Участники групп',
  buyers:   'Купили минибук',
};

async function segmentRecipients(key) {
  if (key === 'all') {
    const { data } = await db.supabase
      .from('users').select('tg_id').eq('is_blocked', false);
    return (data ?? []).map((r) => r.tg_id);
  }

  if (key === 'practice') {
    const { data } = await db.supabase
      .from('practice_subs')
      .select('users(tg_id, is_blocked)')
      .eq('is_active', true);
    return (data ?? [])
      .filter((r) => r.users && !r.users.is_blocked)
      .map((r) => r.users.tg_id);
  }

  const table = key === 'waitlist' ? 'waitlist'
              : key === 'groups'   ? 'group_members'
              : 'orders';

  let q = db.supabase.from(table).select('users(tg_id, is_blocked)');
  if (key === 'groups') q = q.neq('status', 'left');
  if (key === 'buyers') q = q.eq('status', 'paid').eq('product_type', 'digital');

  const { data } = await q;
  const ids = (data ?? [])
    .filter((r) => r.users && !r.users.is_blocked)
    .map((r) => r.users.tg_id);
  return [...new Set(ids)];
}

function isOwner(ctx) {
  return !ENV.OWNER_TG_ID || String(ctx.from?.id) === String(ENV.OWNER_TG_ID);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------
export function registerExtras(bot) {
  // -------------------------------------------------------------------
  // РАССЫЛКА
  // -------------------------------------------------------------------
  bot.command('send', async (ctx) => {
    if (!isOwner(ctx)) return;

    const kb = new InlineKeyboard();
    for (const [key, label] of Object.entries(SEGMENTS)) {
      const count = (await segmentRecipients(key)).length;
      kb.text(`${label} · ${count}`, `bseg:${key}`).row();
    }
    await ctx.reply('Кому отправляем?', { reply_markup: kb });
  });

  bot.callbackQuery(/^bseg:(\w+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();

    const seg  = ctx.match[1];
    const user = await db.ensureUser(ctx.from);
    await db.setState(user.id, 'bcast_text', { segment: seg });

    await ctx.reply(
      `Сегмент: <b>${SEGMENTS[seg]}</b>\n\n` +
      'Пришли текст сообщения. Можно с разметкой Telegram — ' +
      'жирный, курсив, ссылки сохранятся.\n\n' +
      'Отменить — /cancel',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('cancel', async (ctx) => {
    const user = await db.ensureUser(ctx.from);
    await db.clearState(user.id);
    await ctx.reply('Отменила.');
  });

  // Приём текста рассылки
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    if (ctx.message.text?.startsWith('/')) return next();

    const user = await db.ensureUser(ctx.from);

    // --- шаг 1: получили текст, показываем предпросмотр ---
    if (user.state === 'bcast_text') {
      const seg   = user.state_data.segment;
      const count = (await segmentRecipients(seg)).length;

      await db.setState(user.id, 'bcast_confirm', {
        segment: seg,
        text: ctx.message.text,
        entities: ctx.message.entities ?? [],
      });

      const kb = new InlineKeyboard()
        .text(`Отправить ${count} чел.`, 'bsend').row()
        .text('Отмена', 'bcancel');

      await ctx.reply('Так это будет выглядеть 👇');
      await ctx.reply(ctx.message.text, { entities: ctx.message.entities });
      await ctx.reply(`Сегмент: <b>${SEGMENTS[seg]}</b> · ${count} получателей`, {
        parse_mode: 'HTML', reply_markup: kb,
      });
      return;
    }

    return next();
  });

  bot.callbackQuery('bcancel', async (ctx) => {
    const user = await db.ensureUser(ctx.from);
    await db.clearState(user.id);
    await ctx.answerCallbackQuery({ text: 'Отменено' });
    await ctx.reply('Рассылка отменена.');
  });

  bot.callbackQuery('bsend', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery({ text: 'Отправляю…' });

    const owner = await db.ensureUser(ctx.from);
    const { segment, text, entities } = owner.state_data ?? {};
    if (!text) return ctx.reply('Текст потерялся, начни заново: /send');

    await db.clearState(owner.id);

    const ids = await segmentRecipients(segment);
    let ok = 0, blocked = 0, failed = 0;

    for (const tgId of ids) {
      try {
        await bot.api.sendMessage(tgId, text, { entities });
        ok++;
      } catch (e) {
        if (e.error_code === 403) {
          blocked++;
          const u = await db.getUserByTgId(tgId);
          if (u) await db.markBlocked(u.id);
        } else {
          failed++;
        }
      }
      await sleep(40);
    }

    await ctx.reply(
      `Готово 📬\n\n` +
      `Доставлено: ${ok}\n` +
      (blocked ? `Заблокировали бота: ${blocked}\n` : '') +
      (failed  ? `Не доставлено: ${failed}\n` : ''),
    );
  });

  // -------------------------------------------------------------------
  // СТАТИСТИКА
  // -------------------------------------------------------------------
  bot.command('stats', async (ctx) => {
    if (!isOwner(ctx)) return;

    const n = async (table, build) => {
      let q = db.supabase.from(table).select('id', { count: 'exact', head: true });
      if (build) q = build(q);
      const { count } = await q;
      return count ?? 0;
    };

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' })
      .format(new Date());

    const [users, blocked, practice, answersToday, groupMembers,
           waiting, paidOrders, freeSlots, paidSlots] = await Promise.all([
      n('users'),
      n('users', (q) => q.eq('is_blocked', true)),
      n('practice_subs', (q) => q.eq('is_active', true)),
      n('practice_answers', (q) => q.gte('answered_at', `${today}T00:00:00Z`)),
      n('group_members', (q) => q.neq('status', 'left')),
      n('waitlist'),
      n('orders', (q) => q.eq('status', 'paid')),
      n('slots', (q) => q.eq('status', 'free').gt('starts_at', new Date().toISOString())),
      n('slots', (q) => q.eq('status', 'paid').gt('starts_at', new Date().toISOString())),
    ]);

    const { data: revenue } = await db.supabase
      .from('orders').select('amount_eur').eq('status', 'paid');
    const sum = (revenue ?? []).reduce((a, r) => a + Number(r.amount_eur), 0);

    const { data: pending } = await db.supabase
      .from('orders').select('id').eq('status', 'awaiting');

    await ctx.reply(
      `📊 <b>Сводка</b>\n\n` +
      `<b>Люди</b>\n` +
      `Всего в боте: ${users}` + (blocked ? ` (заблокировали: ${blocked})` : '') + `\n\n` +
      `<b>Практика</b>\n` +
      `Подписаны: ${practice}\n` +
      `Ответов сегодня: ${answersToday}\n\n` +
      `<b>Занятия</b>\n` +
      `В группах: ${groupMembers}\n` +
      `Лист ожидания: ${waiting}\n` +
      `Свободных слотов: ${freeSlots}\n` +
      `Оплаченных уроков впереди: ${paidSlots}\n\n` +
      `<b>Деньги</b>\n` +
      `Оплат всего: ${paidOrders} на ${sum.toFixed(0)} €\n` +
      (pending?.length ? `⚠️ Ждут подтверждения: ${pending.length}\n` : ''),
      { parse_mode: 'HTML' },
    );
  });

  // -------------------------------------------------------------------
  // ОТВЕТ НА ЛЮБОЕ НЕПОНЯТНОЕ СООБЩЕНИЕ
  // Регистрируется последним, поэтому ловит только то,
  // что не разобрали остальные модули.
  // -------------------------------------------------------------------
  bot.on('message', async (ctx) => {
    if (ctx.chat.type !== 'private') return;

    const user = await db.ensureUser(ctx.from);
    const text = ctx.message.text ?? '';

    await ctx.reply(
      'Я вижу твоё сообщение и передала его Ангелине — она ответит лично 🙌\n\n' +
      'А пока загляни в меню, там всё самое нужное:',
      { reply_markup: new InlineKeyboard()
          .text('🎯 Задание дня', 'menu:practice').row()
          .text('☰ Главное меню', 'menu:main') },
    );

    if (!ENV.ADMIN_CHAT_ID) return;
    await ctx.api.sendMessage(
      ENV.ADMIN_CHAT_ID,
      `💬 <b>Сообщение боту</b>\n\n` +
      `От: ${escapeHtml(user.first_name ?? '')} ` +
      `${user.username ? '@' + user.username : `(id ${user.tg_id})`}\n\n` +
      (text ? escapeHtml(text.slice(0, 800)) : '[не текст: фото, голосовое или файл]'),
      { parse_mode: 'HTML' },
    ).catch(() => {});
  });
}
