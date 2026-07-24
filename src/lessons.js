import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { ENV } from './config.js';
import { money, escapeHtml, screen, kbBackMain, kbPayMethods } from './ui.js';

const TZ = 'Europe/Kyiv';

// Время показываем и вводим по Киеву — так проще и тебе, и ученикам
function fmtDay(iso) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, weekday: 'short', day: 'numeric', month: 'long',
  }).format(new Date(iso));
}
function fmtTime(iso) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso));
}
function dayKey(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso));
}

// «25.07 15 16 18» + час по Киеву → UTC
function kyivToUtc(dateStr, hour) {
  const [d, m] = dateStr.split('.').map(Number);
  const year = new Date().getFullYear();
  // Киев летом UTC+3, зимой UTC+2 — определяем по самой дате
  const probe = new Date(Date.UTC(year, m - 1, d, 12));
  const offset = probe.toLocaleString('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' });
  const shift = Number(offset) - 12;
  return new Date(Date.UTC(year, m - 1, d, hour - shift));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isOwner(ctx) {
  return !ENV.OWNER_TG_ID || String(ctx.from?.id) === String(ENV.OWNER_TG_ID);
}

// ---------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------
export async function freeSlots() {
  const { data } = await db.supabase
    .from('slots')
    .select('*, teachers(name)')
    .eq('status', 'free')
    .gt('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(100);
  return data ?? [];
}

export async function countFreeSlots() {
  const { count } = await db.supabase
    .from('slots')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'free')
    .gt('starts_at', new Date().toISOString());
  return count ?? 0;
}

async function getSlot(id) {
  const { data } = await db.supabase
    .from('slots').select('*, teachers(name)').eq('id', id).maybeSingle();
  return data;
}

export async function myLessons(userId) {
  const { data } = await db.supabase
    .from('slots')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'paid')
    .gt('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true });
  return data ?? [];
}

// ---------------------------------------------------------------------
// Абонементы
// ---------------------------------------------------------------------
export async function creditsLeft(userId, duration) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db.supabase
    .from('lesson_credits')
    .select('*')
    .eq('user_id', userId)
    .eq('duration_min', duration)
    .order('expires_on', { ascending: true });

  return (data ?? [])
    .filter((c) => !c.expires_on || c.expires_on >= today)
    .filter((c) => c.used < c.total);
}

async function useOneCredit(userId, duration) {
  const packs = await creditsLeft(userId, duration);
  if (!packs.length) return false;
  const p = packs[0];
  await db.supabase.from('lesson_credits')
    .update({ used: p.used + 1 }).eq('id', p.id);
  return true;
}

export async function creditsSummary(userId) {
  const out = [];
  for (const d of [45, 60]) {
    const packs = await creditsLeft(userId, d);
    const left = packs.reduce((a, p) => a + (p.total - p.used), 0);
    if (left) out.push({ duration: d, left, expires: packs[0]?.expires_on });
  }
  return out;
}

export async function deliverPackage(bot, order, tgId) {
  const settings = await db.getSettings();
  const size = Number(settings.pack_size || 10);
  const days = Number(settings.pack_valid_days || 120);
  const duration = order.title_snapshot.includes('45') ? 45 : 60;

  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  const expiresStr = expires.toISOString().slice(0, 10);

  const { data: user } = await db.supabase
    .from('users').select('id').eq('tg_id', tgId).single();

  await db.supabase.from('lesson_credits').insert({
    user_id: user.id,
    duration_min: duration,
    total: size,
    expires_on: expiresStr,
    order_id: order.id,
  });

  await bot.api.sendMessage(
    tgId,
    `Абонемент активирован 🎉\n\n` +
    `<b>${size} занятий по ${duration} минут</b>\n` +
    `Действует до ${expiresStr}\n\n` +
    `Теперь выбирай время в разделе «Индивидуальные уроки» — ` +
    `занятия будут списываться с абонемента, платить каждый раз не нужно.`,
    { parse_mode: 'HTML' },
  );
}

// ---------------------------------------------------------------------
// Выдача после оплаты
// ---------------------------------------------------------------------
export async function deliverLesson(bot, order, tgId) {
  const slot = await getSlot(order.product_ref);
  if (!slot) return;

  await db.supabase.from('slots')
    .update({ status: 'paid' }).eq('id', slot.id);

  await bot.api.sendMessage(
    tgId,
    `Оплата подтверждена 🎉\n\n` +
    `Урок: <b>${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}</b> (по Киеву)\n` +
    `Длительность: ${slot.duration_min} минут\n\n` +
    `Напомню за сутки и за час. Ссылку пришлю перед занятием.`,
    { parse_mode: 'HTML' },
  );

  const { data: teacher } = await db.supabase
    .from('teachers').select('tg_id').eq('id', slot.teacher_id).maybeSingle();
  if (teacher?.tg_id) {
    await bot.api.sendMessage(
      teacher.tg_id,
      `💰 Оплачен урок: ${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}`,
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Фоновые задачи
// ---------------------------------------------------------------------
export async function releaseExpiredHolds() {
  const now = new Date().toISOString();
  const { data } = await db.supabase
    .from('slots')
    .select('id, user_id, order_id')
    .eq('status', 'held')
    .lt('held_until', now);

  for (const s of data ?? []) {
    await db.supabase.from('slots')
      .update({ status: 'free', held_until: null, user_id: null, order_id: null })
      .eq('id', s.id);
    if (s.order_id) {
      await db.supabase.from('orders')
        .update({ status: 'expired' }).eq('id', s.order_id).eq('status', 'created');
    }
  }
  return (data ?? []).length;
}

export async function sendLessonReminders(bot) {
  const now = Date.now();
  const { data } = await db.supabase
    .from('slots')
    .select('*, users(tg_id)')
    .eq('status', 'paid')
    .gt('starts_at', new Date().toISOString());

  let sent = 0;

  for (const s of data ?? []) {
    const diffH = (new Date(s.starts_at) - now) / 3600000;
    const tgId = s.users?.tg_id;
    if (!tgId) continue;

    if (!s.reminded_24h && diffH <= 24 && diffH > 2) {
      await bot.api.sendMessage(
        tgId,
        `Напоминаю: завтра урок в ${fmtTime(s.starts_at)} (по Киеву) 🙌`,
      ).then(async () => {
        sent++;
        await db.supabase.from('slots').update({ reminded_24h: true }).eq('id', s.id);
      }).catch(() => {});
    } else if (!s.reminded_1h && diffH <= 2 && diffH > 0) {
      await bot.api.sendMessage(
        tgId,
        `Урок совсем скоро — в ${fmtTime(s.starts_at)}. До встречи!`,
      ).then(async () => {
        sent++;
        await db.supabase.from('slots').update({ reminded_1h: true }).eq('id', s.id);
      }).catch(() => {});
    }
  }
  return sent;
}

// ---------------------------------------------------------------------
export function registerLessons(bot) {
  // --- Список дней -----------------------------------------------------
  bot.callbackQuery('slots:days', async (ctx) => {
    await ctx.answerCallbackQuery();
    const slots = await freeSlots();

    if (!slots.length) {
      return screen(
        ctx,
        '🎓 <b>Индивидуальные уроки</b>\n\n' +
        'Свободного времени сейчас нет — расписание я обновляю раз в неделю.\n\n' +
        'Напиши мне, и подберём время вручную.',
        kbBackMain(),
      );
    }

    const byDay = new Map();
    for (const s of slots) {
      const k = dayKey(s.starts_at);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(s);
    }

    const kb = new InlineKeyboard();
    for (const [key, list] of byDay) {
      kb.text(`${fmtDay(list[0].starts_at)} · ${list.length} шт.`, `slday:${key}`).row();
    }
    kb.text('← Назад', 'menu:lessons');

    const settings = await db.getSettings();
    const user = await db.ensureUser(ctx.from);
    const mine = await creditsSummary(user.id);

    kb.text('🎟 Абонемент на 10 занятий', 'pack:show').row();

    let head = '🎓 <b>Индивидуальные уроки</b>\n\n' +
      'Один на один — идём в твоём темпе и разбираем именно то, ' +
      'что нужно тебе.\n\n' +
      `<b>Разовое занятие</b>\n` +
      `45 минут — ${money(settings.price_single_45 || 12)}\n` +
      `60 минут — ${money(settings.price_single_60 || 14)}\n\n` +
      'Время указано по Киеву.';

    if (mine.length) {
      const lines = mine.map((c) =>
        `${c.duration} мин — осталось ${c.left}` +
        (c.expires ? ` (до ${c.expires})` : ''));
      head += `\n\n🎟 <b>Твой абонемент</b>\n${lines.join('\n')}`;
    }

    await screen(ctx, `${head}\n\nВыбери день:`, kb);
  });

  // --- Время в выбранный день -------------------------------------------
  bot.callbackQuery(/^slday:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = ctx.match[1];
    const slots = (await freeSlots()).filter((s) => dayKey(s.starts_at) === key);

    if (!slots.length) {
      return ctx.reply('Это время уже разобрали. Выбери другой день.', {
        reply_markup: new InlineKeyboard().text('← К дням', 'slots:days'),
      });
    }

    const kb = new InlineKeyboard();
    slots.forEach((s, i) => {
      kb.text(fmtTime(s.starts_at), `slot:${s.id}`);
      if (i % 3 === 2) kb.row();
    });
    kb.row().text('← К дням', 'slots:days');

    await screen(ctx, `<b>${fmtDay(slots[0].starts_at)}</b>\n\nВыбери время (по Киеву):`, kb);
  });

  // --- Бронь + счёт ------------------------------------------------------
  bot.callbackQuery(/^slot:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const slot = await getSlot(ctx.match[1]);
    const user = await db.ensureUser(ctx.from);

    if (!slot || slot.status !== 'free') {
      return ctx.reply('Это время только что заняли 🙈 Выбери другое.', {
        reply_markup: new InlineKeyboard().text('← К дням', 'slots:days'),
      });
    }

    const settings = await db.getSettings();
    const duration = slot.duration_min || 60;

    // Есть абонемент — списываем занятие, оплата не нужна
    const packs = await creditsLeft(user.id, duration);
    if (packs.length) {
      const ok = await useOneCredit(user.id, duration);
      if (ok) {
        await db.supabase.from('slots')
          .update({ status: 'paid', user_id: user.id }).eq('id', slot.id);

        const left = (await creditsSummary(user.id))
          .find((c) => c.duration === duration)?.left ?? 0;

        await ctx.reply(
          `Записала 🎉\n\n` +
          `<b>${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}</b> (по Киеву)\n` +
          `Занятие ${duration} минут, списано с абонемента.\n` +
          `Осталось занятий: <b>${left}</b>\n\n` +
          `Напомню за сутки и за час.`,
          { parse_mode: 'HTML', reply_markup: kbBackMain() },
        );

        const { data: teacher } = await db.supabase
          .from('teachers').select('tg_id').eq('id', slot.teacher_id).maybeSingle();
        if (teacher?.tg_id) {
          await ctx.api.sendMessage(
            teacher.tg_id,
            `📅 Запись по абонементу: ${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}`,
          ).catch(() => {});
        }
        return;
      }
    }

    const price = slot.price_eur
      ?? Number(settings[`price_single_${duration}`] || 14);
    const holdMin = Number(settings.lesson_hold_minutes || 60);

    const order = await db.createOrder(user, {
      type: 'lesson',
      id: slot.id,
      title: `Урок ${duration} мин · ${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}`,
      price_eur: price,
    });

    await db.supabase.from('slots').update({
      status: 'held',
      user_id: user.id,
      order_id: order.id,
      held_until: new Date(Date.now() + holdMin * 60000).toISOString(),
    }).eq('id', slot.id).eq('status', 'free');

    await ctx.reply(
      `<b>${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}</b> (по Киеву)\n` +
      `Урок ${duration} минут · <b>${money(price)}</b>\n\n` +
      `Время держу за тобой ${holdMin} минут. Выбери способ оплаты:`,
      { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
    );
  });

  // --- Абонемент ---------------------------------------------------------
  bot.callbackQuery('pack:show', async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await db.getSettings();
    const size = Number(s.pack_size || 10);
    const days = Number(s.pack_valid_days || 120);

    const p45 = Number(s.price_pack_45 || 114);
    const p60 = Number(s.price_pack_60 || 130);
    const e45 = Number(s.price_single_45 || 12) * size - p45;
    const e60 = Number(s.price_single_60 || 14) * size - p60;

    const kb = new InlineKeyboard()
      .text(`45 минут · ${money(p45)}`, 'pack:buy:45').row()
      .text(`60 минут · ${money(p60)}`, 'pack:buy:60').row()
      .text('← Назад', 'slots:days');

    await screen(
      ctx,
      `🎟 <b>Абонемент на ${size} занятий</b>\n\n` +
      'Выгоднее разовых и не нужно оплачивать каждый урок — ' +
      'просто выбираешь время, занятие списывается само.\n\n' +
      `<b>45 минут</b> — ${money(p45)} вместо ${money(Number(s.price_single_45 || 12) * size)}` +
      (e45 > 0 ? ` (экономия ${money(e45)})` : '') + '\n' +
      `<b>60 минут</b> — ${money(p60)} вместо ${money(Number(s.price_single_60 || 14) * size)}` +
      (e60 > 0 ? ` (экономия ${money(e60)})` : '') + '\n\n' +
      `Действует ${days} дней с момента покупки.`,
      kb,
    );
  });

  bot.callbackQuery(/^pack:buy:(45|60)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const duration = Number(ctx.match[1]);
    const s = await db.getSettings();
    const size  = Number(s.pack_size || 10);
    const price = Number(s[`price_pack_${duration}`] || 130);
    const user  = await db.ensureUser(ctx.from);

    const order = await db.createOrder(user, {
      type: 'package',
      id: null,
      title: `Абонемент ${size} занятий по ${duration} мин`,
      price_eur: price,
    });

    await ctx.reply(
      `<b>Абонемент: ${size} занятий по ${duration} минут</b>\n` +
      `К оплате: <b>${money(price)}</b>\n\n` +
      'Выбери способ оплаты:',
      { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
    );
  });

  // -------------------------------------------------------------------
  // АДМИНКА
  // -------------------------------------------------------------------
  bot.command('addslots', async (ctx) => {
    if (!isOwner(ctx)) return;
    return addSlots(ctx, 60);
  });

  async function addSlots(ctx, duration) {
    const arg = (ctx.match ?? '').trim();

    if (!arg) {
      return ctx.reply(
        'Формат: <code>/addslots 25.07 15 16 18</code>\n\n' +
        'Дата, потом часы через пробел. Время по Киеву.\n' +
        '<code>/addslots</code> — уроки по 60 минут\n' +
        '<code>/addslots45</code> — уроки по 45 минут\n\n' +
        'Можно несколько дней — по одной команде на день.',
        { parse_mode: 'HTML' },
      );
    }

    const parts = arg.split(/\s+/);
    const date  = parts[0];
    const hours = parts.slice(1).map(Number).filter((h) => h >= 0 && h <= 23);

    if (!/^\d{1,2}\.\d{1,2}$/.test(date) || !hours.length) {
      return ctx.reply('Не разобрала. Пример: /addslots 25.07 15 16 18');
    }

    const { data: teacher } = await db.supabase
      .from('teachers').select('id').eq('role', 'owner').maybeSingle();
    const settings = await db.getSettings();

    let added = 0, skipped = 0;
    for (const h of hours) {
      const when = kyivToUtc(date, h);
      const { error } = await db.supabase.from('slots').insert({
        teacher_id: teacher?.id ?? null,
        starts_at: when.toISOString(),
        duration_min: duration,
        price_eur: Number(settings[`price_single_${duration}`] || 14),
      });
      if (error) skipped++; else added++;
    }

    await ctx.reply(
      `Добавлено слотов по ${duration} мин: ${added}` +
      (skipped ? `\nУже были: ${skipped}` : ''),
    );
  }

  bot.command('addslots45', async (ctx) => {
    if (!isOwner(ctx)) return;
    ctx.match = (ctx.match ?? '').trim();
    return addSlots(ctx, 45);
  });

  bot.command('slots', async (ctx) => {
    if (!isOwner(ctx)) return;
    const { data } = await db.supabase
      .from('slots')
      .select('*, users(first_name, username)')
      .gt('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(40);

    if (!data?.length) {
      return ctx.reply(
        'Свободных слотов нет.\n\nДобавить: /addslots 25.07 15 16 18',
      );
    }

    const mark = { free: '🟢', held: '⏳', paid: '✅', done: '☑️', cancelled: '⚪️' };
    const lines = data.map((s) => {
      const who = s.users
        ? ` · ${s.users.username ? '@' + s.users.username : s.users.first_name}`
        : '';
      return `${mark[s.status]} ${fmtDay(s.starts_at)} ${fmtTime(s.starts_at)} · ${s.duration_min}м${who}`;
    });

    await ctx.reply(
      `<b>Ближайшие слоты</b>\n\n${lines.join('\n')}\n\n` +
      'Добавить: <code>/addslots 25.07 15 16 18</code>\n' +
      'Удалить свободные за день: <code>/delslots 25.07</code>',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('delslots', async (ctx) => {
    if (!isOwner(ctx)) return;
    const date = (ctx.match ?? '').trim();
    if (!/^\d{1,2}\.\d{1,2}$/.test(date)) {
      return ctx.reply('Формат: /delslots 25.07');
    }

    const from = kyivToUtc(date, 0).toISOString();
    const to   = kyivToUtc(date, 23).toISOString();

    const { data } = await db.supabase
      .from('slots').delete()
      .eq('status', 'free')
      .gte('starts_at', from).lte('starts_at', to)
      .select('id');

    await ctx.reply(`Удалено свободных слотов: ${data?.length ?? 0}`);
  });
}
