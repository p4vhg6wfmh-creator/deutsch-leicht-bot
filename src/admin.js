/**
 * admin.js — личный кабинет учителя
 *
 * Команды (только для владельца):
 *   /today       — уроки сегодня с кнопками ✓ / ✕
 *   /unpaid      — кто ещё не оплатил (ожидающие заказы)
 *   /pay <имя> <сумма> — быстро записать оплату наличными/переводом
 */

import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { ENV } from './config.js';

const TZ = 'Europe/Berlin';

function isOwner(ctx) {
  return !ENV.OWNER_TG_ID || String(ctx.from?.id) === String(ENV.OWNER_TG_ID);
}

// Форматирование времени в часовом поясе TZ
function fmtTime(iso) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}

// Сегодняшняя дата в TZ в формате YYYY-MM-DD
function todayInTz() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

// Завтрашняя дата в TZ
function tomorrowInTz() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

// Получить уроки на сегодня (оплаченные и запланированные слоты)
async function todaySlots() {
  const today = todayInTz();
  const tomorrow = tomorrowInTz();

  const { data } = await db.supabase
    .from('slots')
    .select('*, users(first_name, username, tg_id)')
    .in('status', ['paid', 'done', 'cancelled'])
    .gte('starts_at', `${today}T00:00:00Z`)
    .lt('starts_at', `${tomorrow}T00:00:00Z`)
    .order('starts_at', { ascending: true });

  return data ?? [];
}

// Получить ожидающие подтверждения заказы
async function pendingOrders() {
  const { data } = await db.supabase
    .from('orders')
    .select('*, users(first_name, username, tg_id)')
    .eq('status', 'awaiting')
    .order('created_at', { ascending: true });
  return data ?? [];
}

// Имя ученика из слота
function studentName(slot) {
  if (!slot.users) return 'Неизвестный';
  const u = slot.users;
  return u.first_name || u.username || `id${u.tg_id}`;
}

// Статус слота в виде эмодзи
function statusIcon(status) {
  if (status === 'done') return '✅';
  if (status === 'cancelled') return '❌';
  return '📅'; // paid / planned
}

// ---------------------------------------------------------------------
export function registerAdmin(bot) {

  // -------------------------------------------------------------------
  // /today — уроки на сегодня
  // -------------------------------------------------------------------
  bot.command('today', async (ctx) => {
    if (!isOwner(ctx)) return;

    const slots = await todaySlots();

    if (!slots.length) {
      await ctx.reply('📭 Уроков на сегодня нет.');
      return;
    }

    const today = new Intl.DateTimeFormat('ru-RU', {
      timeZone: TZ, day: 'numeric', month: 'long', weekday: 'long',
    }).format(new Date());

    let text = `📅 <b>Уроки на ${today}</b>\n\n`;

    const kb = new InlineKeyboard();
    let hasPending = false;

    for (const slot of slots) {
      const time = fmtTime(slot.starts_at);
      const name = studentName(slot);
      const icon = statusIcon(slot.status);
      const dur = slot.duration_min ? ` · ${slot.duration_min} мин` : '';

      text += `${icon} <b>${time}</b>${dur} — ${name}\n`;

      if (slot.status === 'paid') {
        hasPending = true;
        kb.text(`✅ ${time} ${name}`, `adm:done:${slot.id}`)
          .text(`❌ отмена`, `adm:cancel:${slot.id}`)
          .row();
      }
    }

    if (!hasPending) {
      text += '\n<i>Все уроки уже отмечены.</i>';
      await ctx.reply(text, { parse_mode: 'HTML' });
    } else {
      text += '\n<i>Отметь проведённые уроки:</i>';
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
  });

  // Нажатие ✅ — урок проведён
  bot.callbackQuery(/^adm:done:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();

    const slotId = ctx.match[1];
    const { data: slot } = await db.supabase
      .from('slots').update({ status: 'done' })
      .eq('id', slotId).select('*, users(first_name)').single();

    await ctx.answerCallbackQuery({ text: '✅ Отмечен как проведённый' });

    const name = slot?.users?.first_name ?? 'ученик';
    const time = slot ? fmtTime(slot.starts_at) : '';
    await ctx.editMessageText(
      `✅ Урок ${time} с <b>${name}</b> — проведён.`,
      { parse_mode: 'HTML' },
    );
  });

  // Нажатие ❌ — урок отменён
  bot.callbackQuery(/^adm:cancel:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();

    const slotId = ctx.match[1];
    const { data: slot } = await db.supabase
      .from('slots').update({ status: 'cancelled' })
      .eq('id', slotId).select('*, users(first_name)').single();

    await ctx.answerCallbackQuery({ text: '❌ Урок отменён' });

    const name = slot?.users?.first_name ?? 'ученик';
    const time = slot ? fmtTime(slot.starts_at) : '';
    await ctx.editMessageText(
      `❌ Урок ${time} с <b>${name}</b> — отменён.`,
      { parse_mode: 'HTML' },
    );
  });

  // -------------------------------------------------------------------
  // /unpaid — кто ждёт подтверждения оплаты
  // -------------------------------------------------------------------
  bot.command('unpaid', async (ctx) => {
    if (!isOwner(ctx)) return;

    const orders = await pendingOrders();

    if (!orders.length) {
      await ctx.reply('✅ Неподтверждённых оплат нет.');
      return;
    }

    let text = `💰 <b>Ждут подтверждения (${orders.length})</b>\n\n`;

    for (const o of orders) {
      const u = o.users;
      const name = u?.first_name || u?.username || `id${u?.tg_id}`;
      const date = new Date(o.created_at).toLocaleDateString('ru-RU', { timeZone: TZ });
      text += `• <b>${name}</b> — ${o.title_snapshot} · ${o.amount_eur} € · ${date}\n`;
      if (u?.username) text += `  @${u.username}\n`;
    }

    text += '\n<i>Подтвердить можно через /invoice или в разделе оплат.</i>';

    await ctx.reply(text, { parse_mode: 'HTML' });
  });

  // -------------------------------------------------------------------
  // /pay <имя или @username> <сумма> — записать ручную оплату
  // Пример: /pay Василиса 500
  //         /pay @username 12
  // -------------------------------------------------------------------
  bot.command('pay', async (ctx) => {
    if (!isOwner(ctx)) return;

    const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
    if (args.length < 2) {
      await ctx.reply(
        '❗️ Использование:\n<code>/pay Имя Сумма</code>\n\nПример: <code>/pay Василиса 500</code>',
        { parse_mode: 'HTML' },
      );
      return;
    }

    const amount = parseFloat(args[args.length - 1]);
    if (isNaN(amount) || amount <= 0) {
      await ctx.reply('❗️ Неверная сумма. Пример: <code>/pay Василиса 500</code>', { parse_mode: 'HTML' });
      return;
    }

    const nameQuery = args.slice(0, -1).join(' ');

    // Ищем пользователя по имени или username
    let user = null;
    if (nameQuery.startsWith('@')) {
      const uname = nameQuery.slice(1);
      const { data } = await db.supabase
        .from('users').select('*')
        .ilike('username', uname).maybeSingle();
      user = data;
    } else {
      const { data } = await db.supabase
        .from('users').select('*')
        .ilike('first_name', `%${nameQuery}%`).limit(1).maybeSingle();
      user = data;
    }

    if (!user) {
      await ctx.reply(`❗️ Пользователь «${nameQuery}» не найден в базе бота.\n\nПроверь имя или используй @username.`);
      return;
    }

    // Записываем заказ со статусом paid (ручная оплата)
    const { data: order, error } = await db.supabase
      .from('orders')
      .insert({
        user_id:        user.id,
        product_type:   'manual',
        title_snapshot: `Ручная оплата от ${new Date().toLocaleDateString('ru-RU', { timeZone: TZ })}`,
        amount_eur:     amount,
        status:         'paid',
        confirmed_at:   new Date().toISOString(),
      })
      .select().single();

    if (error) {
      await ctx.reply(`❗️ Ошибка записи: ${error.message}`);
      return;
    }

    const displayName = user.first_name || user.username || `id${user.tg_id}`;
    await ctx.reply(
      `✅ Оплата записана\n\n` +
      `👤 ${displayName}\n` +
      `💰 ${amount} (eur/грн)\n` +
      `📝 ID записи: ${order.id}`,
    );
  });
}

// ---------------------------------------------------------------------
// Вечернее напоминание — вызывается из cron
// ---------------------------------------------------------------------
export async function sendEveningReminder(bot) {
  if (!ENV.OWNER_TG_ID) return 0;

  const slots = await todaySlots();
  const pending = slots.filter((s) => s.status === 'paid'); // не отмечены

  const pendingOrders_ = await pendingOrders();

  if (!pending.length && !pendingOrders_.length) return 0;

  let text = '🌙 <b>Итоги дня — не забудь отметить!</b>\n\n';

  if (pending.length) {
    text += `📅 <b>Не отмечены уроки (${pending.length}):</b>\n`;
    for (const s of pending) {
      text += `• ${fmtTime(s.starts_at)} — ${studentName(s)}\n`;
    }
    text += '\n→ /today\n\n';
  }

  if (pendingOrders_.length) {
    text += `💰 <b>Ждут подтверждения оплаты (${pendingOrders_.length}):</b>\n`;
    for (const o of pendingOrders_) {
      const name = o.users?.first_name || o.users?.username || '?';
      text += `• ${name} — ${o.amount_eur} €\n`;
    }
    text += '\n→ /unpaid';
  }

  await bot.api.sendMessage(ENV.OWNER_TG_ID, text, { parse_mode: 'HTML' });
  return 1;
}
