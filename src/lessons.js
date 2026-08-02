import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { ENV } from './config.js';
import { money, escapeHtml, screen, kbBackMain, kbPayMethods } from './ui.js';

// Часовой пояс расписания берётся из настроек (lesson_tz).
// В нём ты вводишь слоты, в нём же их видят ученики.
let TZ = 'Europe/Berlin';
async function loadTz() {
  const s = await db.getSettings();
  TZ = s.lesson_tz || 'Europe/Berlin';
  return TZ;
}

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
function tzLabel() {
  return TZ === 'Europe/Kyiv' ? 'по Киеву'
       : TZ === 'Europe/Berlin' ? 'по Берлину'
       : `(${TZ})`;
}

// Смещение зоны в минутах на конкретный момент — с учётом перехода на летнее время
function tzOffsetMinutes(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return (asUtc - date.getTime()) / 60000;
}

// «27.07» + 16:10 по TZ → момент в UTC
function localToUtc(dateStr, hour, minute) {
  const [d, m] = dateStr.split('.').map(Number);
  const now = new Date();
  let year = now.getFullYear();
  // если дата уже прошла — значит имеется в виду следующий год
  if (new Date(year, m - 1, d, 23, 59) < now) year += 1;

  const wall = Date.UTC(year, m - 1, d, hour, minute);
  let off = tzOffsetMinutes(new Date(wall), TZ);
  let result = wall - off * 60000;
  off = tzOffsetMinutes(new Date(result), TZ);
  return new Date(wall - off * 60000);
}

// «16», «16:10», «16.10» → { hour, minute }
function parseTimeToken(tok) {
  let m = /^(\d{1,2})$/.exec(tok);
  if (m) return { hour: +m[1], minute: 0 };
  m = /^(\d{1,2})[:.](\d{2})$/.exec(tok);
  if (m) return { hour: +m[1], minute: +m[2] };
  return null;
}

function isOwner(ctx) {
  return !ENV.OWNER_TG_ID || String(ctx.from?.id) === String(ENV.OWNER_TG_ID);
}

// ---------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------
export async function freeSlots() {
  const { data } = await db.supabase
    .from('slots').select('*, teachers(name)')
    .eq('status', 'free')
    .gt('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true }).limit(100);
  return data ?? [];
}

async function getSlot(id) {
  const { data } = await db.supabase
    .from('slots').select('*, teachers(name)').eq('id', id).maybeSingle();
  return data;
}

export async function myLessons(userId) {
  const { data } = await db.supabase
    .from('slots').select('*').eq('user_id', userId).eq('status', 'paid')
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
    .from('lesson_credits').select('*')
    .eq('user_id', userId).eq('duration_min', duration)
    .order('expires_on', { ascending: true });

  return (data ?? [])
    .filter((c) => !c.expires_on || c.expires_on >= today)
    .filter((c) => c.used < c.total);
}

async function useOneCredit(userId, duration) {
  const packs = await creditsLeft(userId, duration);
  if (!packs.length) return false;
  const p = packs[0];
  await db.supabase.from('lesson_credits').update({ used: p.used + 1 }).eq('id', p.id);
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
  const s = await db.getSettings();
  const size = Number(s.pack_size || 10);
  const days = Number(s.pack_valid_days || 120);
  const duration = order.title_snapshot.includes('45') ? 45 : 60;

  const expires = new Date();
  expires.setDate(expires.getDate() + days);
  const expiresStr = expires.toISOString().slice(0, 10);

  const { data: user } = await db.supabase
    .from('users').select('id').eq('tg_id', tgId).single();

  await db.supabase.from('lesson_credits').insert({
    user_id: user.id, duration_min: duration,
    total: size, expires_on: expiresStr, order_id: order.id,
  });

  await bot.api.sendMessage(
    tgId,
    `Абонемент активирован 🎉\n\n` +
    `<b>${size} занятий по ${duration} минут</b>\n` +
    `Действует до ${expiresStr}\n\n` +
    `Выбирай время в разделе «Индивидуальные уроки» — ` +
    `занятия списываются с абонемента, платить каждый раз не нужно.\n\n` +
    `<b>Отмена занятия</b>\n${s.cancel_policy ?? ''}`,
    { parse_mode: 'HTML' },
  );
}

// ---------------------------------------------------------------------
// Выдача после оплаты разового урока
// ---------------------------------------------------------------------
export async function deliverLesson(bot, order, tgId) {
  await loadTz();
  const s0 = await db.getSettings();

  // Счёт без слота (выставлен вручную через /invoice) — просто подтверждаем
  if (!order.product_ref) {
    await bot.api.sendMessage(
      tgId,
      `Оплата подтверждена 🎉\n\n` +
      `Индивидуальный урок оплачен. До встречи в согласованное время!\n\n` +
      `<b>Отмена занятия</b>\n${s0.cancel_policy ?? ''}`,
      { parse_mode: 'HTML' },
    );
    await bot.api.sendMessage(ENV.ADMIN_CHAT_ID,
      `💰 Оплачен индивидуальный урок (счёт вручную).`).catch(() => {});
    return;
  }

  const slot = await getSlot(order.product_ref);
  if (!slot) return;

  await db.supabase.from('slots').update({ status: 'paid' }).eq('id', slot.id);
  const s = await db.getSettings();

  await bot.api.sendMessage(
    tgId,
    `Оплата подтверждена 🎉\n\n` +
    `Урок: <b>${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}</b> ${tzLabel()}\n` +
    `Длительность: ${slot.duration_min} минут\n\n` +
    `Напомню за сутки и за час. Ссылку пришлю перед занятием.\n\n` +
    `<b>Отмена занятия</b>\n${s.cancel_policy ?? ''}`,
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
    .from('slots').select('id, order_id')
    .eq('status', 'held').lt('held_until', now);

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
  await loadTz();
  const now = Date.now();
  const { data } = await db.supabase
    .from('slots').select('*, users(tg_id)')
    .eq('status', 'paid').gt('starts_at', new Date().toISOString());

  let sent = 0;
  for (const s of data ?? []) {
    const diffH = (new Date(s.starts_at) - now) / 3600000;
    const tgId = s.users?.tg_id;
    if (!tgId) continue;

    if (!s.reminded_24h && diffH <= 24 && diffH > 2) {
      await bot.api.sendMessage(tgId,
        `Напоминаю: завтра урок в ${fmtTime(s.starts_at)} ${tzLabel()} 🙌`)
        .then(async () => {
          sent++;
          await db.supabase.from('slots').update({ reminded_24h: true }).eq('id', s.id);
        }).catch(() => {});
    } else if (!s.reminded_1h && diffH <= 2 && diffH > 0) {
      await bot.api.sendMessage(tgId,
        `Урок совсем скоро — в ${fmtTime(s.starts_at)}. До встречи!`)
        .then(async () => {
          sent++;
          await db.supabase.from('slots').update({ reminded_1h: true }).eq('id', s.id);
        }).catch(() => {});
    }
  }
  return sent;
}

// ---------------------------------------------------------------------
export function registerLessons(bot) {
  // --- Главный экран уроков: информация есть всегда --------------------
  bot.callbackQuery('slots:days', async (ctx) => {
    await ctx.answerCallbackQuery();
    await loadTz();

    const s = await db.getSettings();
    const user = await db.ensureUser(ctx.from);
    const slots = await freeSlots();
    const mine = await creditsSummary(user.id);

    let text =
      '🎓 <b>Индивидуальные уроки</b>\n\n' +
      'Один на один — идём в твоём темпе и разбираем именно то, ' +
      'что нужно тебе.\n\n' +
      '<b>Разовое занятие</b>\n' +
      `45 минут — ${money(s.price_single_45 || 12)}\n` +
      `60 минут — ${money(s.price_single_60 || 14)}\n\n` +
      `<b>Абонемент на ${s.pack_size || 10} занятий</b>\n` +
      `45 минут — ${money(s.price_pack_45 || 114)}\n` +
      `60 минут — ${money(s.price_pack_60 || 130)}\n\n` +
      `Время указано ${tzLabel()}.\n\n` +
      `<b>Отмена занятия</b>\n${s.cancel_policy ?? ''}`;

    if (mine.length) {
      const lines = mine.map((c) =>
        `${c.duration} мин — осталось ${c.left}` + (c.expires ? ` (до ${c.expires})` : ''));
      text += `\n\n🎟 <b>Твой абонемент</b>\n${lines.join('\n')}`;
    }

    const kb = new InlineKeyboard();

    if (slots.length) {
      const byDay = new Map();
      for (const sl of slots) {
        const k = dayKey(sl.starts_at);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(sl);
      }
      text += '\n\n<b>Свободное время:</b>';
      for (const [key, list] of byDay) {
        kb.text(`${fmtDay(list[0].starts_at)} · ${list.length} шт.`, `slday:${key}`).row();
      }
    } else {
      text += '\n\n📭 Свободного времени сейчас нет — расписание обновляю раз в неделю. ' +
              'Оставь заявку, и подберу время лично.';
      kb.text('Оставить заявку на время', 'slots:req').row();
    }

    kb.text('🎟 Абонемент на 10 занятий', 'pack:show').row();
    kb.text('← Назад', 'menu:lessons');

    await screen(ctx, text, kb);
  });

  // --- Заявка, когда слотов нет ------------------------------------------
  bot.callbackQuery('slots:req', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.ensureUser(ctx.from);
    await db.setState(user.id, 'slot_request', {});
    await ctx.reply(
      'Напиши одним сообщением, когда тебе удобно заниматься — ' +
      'дни недели и примерное время. Я подберу и вернусь с вариантами.',
    );
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    if (ctx.message.text?.startsWith('/')) return next();

    const user = await db.ensureUser(ctx.from);
    if (user.state !== 'slot_request') return next();

    await db.clearState(user.id);
    await ctx.reply('Спасибо! Посмотрю расписание и вернусь с вариантами 🙌',
      { reply_markup: kbBackMain() });

    await ctx.api.sendMessage(
      ENV.ADMIN_CHAT_ID,
      `🗓 <b>Заявка на индивидуальные</b>\n\n` +
      `От: ${escapeHtml(user.first_name ?? '')} ` +
      `${user.username ? '@' + user.username : `(id ${user.tg_id})`}\n\n` +
      escapeHtml(ctx.message.text.slice(0, 600)),
      { parse_mode: 'HTML' },
    ).catch(() => {});
  });

  // --- Время в выбранный день --------------------------------------------
  bot.callbackQuery(/^slday:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await loadTz();
    const key = ctx.match[1];
    const slots = (await freeSlots()).filter((s) => dayKey(s.starts_at) === key);

    if (!slots.length) {
      return ctx.reply('Это время уже разобрали. Выбери другой день.', {
        reply_markup: new InlineKeyboard().text('← К расписанию', 'slots:days'),
      });
    }

    const kb = new InlineKeyboard();
    slots.forEach((s, i) => {
      kb.text(`${fmtTime(s.starts_at)} · ${s.duration_min}м`, `slot:${s.id}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text('← К расписанию', 'slots:days');

    await screen(ctx,
      `<b>${fmtDay(slots[0].starts_at)}</b>\n\nВыбери время (${tzLabel()}):`, kb);
  });

  // --- Бронь --------------------------------------------------------------
  bot.callbackQuery(/^slot:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await loadTz();
    const slot = await getSlot(ctx.match[1]);
    const user = await db.ensureUser(ctx.from);

    if (!slot || slot.status !== 'free') {
      return ctx.reply('Это время только что заняли 🙈 Выбери другое.', {
        reply_markup: new InlineKeyboard().text('← К расписанию', 'slots:days'),
      });
    }

    const s = await db.getSettings();
    const duration = slot.duration_min || 60;

    // Есть абонемент — списываем занятие
    if ((await creditsLeft(user.id, duration)).length) {
      const ok = await useOneCredit(user.id, duration);
      if (ok) {
        await db.supabase.from('slots')
          .update({ status: 'paid', user_id: user.id }).eq('id', slot.id);

        const left = (await creditsSummary(user.id))
          .find((c) => c.duration === duration)?.left ?? 0;

        await ctx.reply(
          `Записала 🎉\n\n` +
          `<b>${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}</b> ${tzLabel()}\n` +
          `Занятие ${duration} минут, списано с абонемента.\n` +
          `Осталось занятий: <b>${left}</b>\n\n` +
          `Напомню за сутки и за час.\n\n` +
          `<b>Отмена занятия</b>\n${s.cancel_policy ?? ''}`,
          { parse_mode: 'HTML', reply_markup: kbBackMain() },
        );

        const { data: teacher } = await db.supabase
          .from('teachers').select('tg_id').eq('id', slot.teacher_id).maybeSingle();
        if (teacher?.tg_id) {
          await ctx.api.sendMessage(teacher.tg_id,
            `📅 Запись по абонементу: ${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}`)
            .catch(() => {});
        }
        return;
      }
    }

    const price = slot.price_eur ?? Number(s[`price_single_${duration}`] || 14);
    const holdMin = Number(s.lesson_hold_minutes || 60);

    const order = await db.createOrder(user, {
      type: 'lesson', id: slot.id,
      title: `Урок ${duration} мин · ${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}`,
      price_eur: price,
    });

    await db.supabase.from('slots').update({
      status: 'held', user_id: user.id, order_id: order.id,
      held_until: new Date(Date.now() + holdMin * 60000).toISOString(),
    }).eq('id', slot.id).eq('status', 'free');

    await ctx.reply(
      `<b>${fmtDay(slot.starts_at)}, ${fmtTime(slot.starts_at)}</b> ${tzLabel()}\n` +
      `Урок ${duration} минут · <b>${money(price)}</b>\n\n` +
      `Время держу за тобой ${holdMin} минут. Выбери способ оплаты:`,
      { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
    );
  });

  // --- Абонемент -----------------------------------------------------------
  bot.callbackQuery('pack:show', async (ctx) => {
    await ctx.answerCallbackQuery();
    const s = await db.getSettings();
    const size = Number(s.pack_size || 10);
    const days = Number(s.pack_valid_days || 120);
    const p45 = Number(s.price_pack_45 || 114);
    const p60 = Number(s.price_pack_60 || 130);
    const f45 = Number(s.price_single_45 || 12) * size;
    const f60 = Number(s.price_single_60 || 14) * size;

    const kb = new InlineKeyboard()
      .text(`45 минут · ${money(p45)}`, 'pack:buy:45').row()
      .text(`60 минут · ${money(p60)}`, 'pack:buy:60').row()
      .text('← Назад', 'slots:days');

    await screen(ctx,
      `🎟 <b>Абонемент на ${size} занятий</b>\n\n` +
      'Выгоднее разовых, и не нужно оплачивать каждый урок — ' +
      'выбираешь время, занятие списывается само.\n\n' +
      `<b>45 минут</b> — ${money(p45)} вместо ${money(f45)}` +
      (f45 > p45 ? ` (экономия ${money(f45 - p45)})` : '') + '\n' +
      `<b>60 минут</b> — ${money(p60)} вместо ${money(f60)}` +
      (f60 > p60 ? ` (экономия ${money(f60 - p60)})` : '') + '\n\n' +
      `Действует ${days} дней с момента покупки.\n\n` +
      `<b>Отмена занятия</b>\n${s.cancel_policy ?? ''}`,
      kb);
  });

  bot.callbackQuery(/^pack:buy:(45|60)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const duration = Number(ctx.match[1]);
    const s = await db.getSettings();
    const size = Number(s.pack_size || 10);
    const price = Number(s[`price_pack_${duration}`] || 130);
    const user = await db.ensureUser(ctx.from);

    const order = await db.createOrder(user, {
      type: 'package', id: null,
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
  async function addSlots(ctx, duration) {
    await loadTz();
    const arg = (ctx.match ?? '').trim();

    if (!arg) {
      return ctx.reply(
        `Формат: <code>/addslots${duration === 45 ? '45' : ''} 27.07 16:10 17:30 19</code>\n\n` +
        `Дата, потом время через пробел. Можно с минутами и без.\n` +
        `Время ${tzLabel()}, урок ${duration} минут.\n\n` +
        `<code>/addslots</code> — по 60 минут\n` +
        `<code>/addslots45</code> — по 45 минут`,
        { parse_mode: 'HTML' },
      );
    }

    const parts = arg.split(/\s+/);
    const date = parts[0];
    if (!/^\d{1,2}\.\d{1,2}$/.test(date)) {
      return ctx.reply('Дата должна быть вида 27.07. Пример: /addslots 27.07 16:10 18');
    }

    const times = parts.slice(1).map(parseTimeToken).filter(Boolean);
    if (!times.length) {
      return ctx.reply('Не разобрала время. Пример: /addslots 27.07 16:10 17:30 19');
    }

    const { data: teacher } = await db.supabase
      .from('teachers').select('id').eq('role', 'owner').maybeSingle();
    const s = await db.getSettings();

    let added = 0, skipped = 0;
    const list = [];
    for (const t of times) {
      const when = localToUtc(date, t.hour, t.minute);
      const { error } = await db.supabase.from('slots').insert({
        teacher_id: teacher?.id ?? null,
        starts_at: when.toISOString(),
        duration_min: duration,
        price_eur: Number(s[`price_single_${duration}`] || 14),
      });
      if (error) skipped++;
      else { added++; list.push(fmtTime(when.toISOString())); }
    }

    await ctx.reply(
      `Добавлено слотов по ${duration} мин: ${added}` +
      (list.length ? `\n${fmtDay(localToUtc(date, times[0].hour, times[0].minute).toISOString())}: ${list.join(', ')} (${tzLabel()})` : '') +
      (skipped ? `\nУже были: ${skipped}` : ''),
    );
  }

  bot.command('addslots',   (ctx) => isOwner(ctx) ? addSlots(ctx, 60) : null);
  bot.command('addslots45', (ctx) => isOwner(ctx) ? addSlots(ctx, 45) : null);

  bot.command('slots', async (ctx) => {
    if (!isOwner(ctx)) return;
    await loadTz();
    const { data } = await db.supabase
      .from('slots').select('*, users(first_name, username)')
      .gt('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true }).limit(40);

    if (!data?.length) {
      return ctx.reply(
        'Слотов нет.\n\nДобавить: /addslots 27.07 16:10 18\nИли на 45 минут: /addslots45 27.07 16:10',
      );
    }

    const mark = { free: '🟢', held: '⏳', paid: '✅', done: '☑️', cancelled: '⚪️' };
    const lines = data.map((s) => {
      const who = s.users
        ? ` · ${s.users.username ? '@' + s.users.username : s.users.first_name}` : '';
      return `${mark[s.status]} ${fmtDay(s.starts_at)} ${fmtTime(s.starts_at)} · ${s.duration_min}м${who}`;
    });

    await ctx.reply(
      `<b>Ближайшие слоты</b> (${tzLabel()})\n\n${lines.join('\n')}\n\n` +
      'Добавить: <code>/addslots 27.07 16:10 18</code>\n' +
      'Удалить свободные за день: <code>/delslots 27.07</code>',
      { parse_mode: 'HTML' },
    );
  });

  // Выставить счёт за индивидуальный урок вручную (когда время согласовано лично)
  //   /invoice @username 14
  //   /invoice @username 14 45   (45-минутный)
  //   /invoice 123456789 12
  bot.command('invoice', async (ctx) => {
    if (!isOwner(ctx)) return;
    const parts = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);

    if (parts.length < 2) {
      const s = await db.getSettings();
      return ctx.reply(
        'Выставить счёт за индивидуальный урок:\n\n' +
        '<code>/invoice @username сумма</code>\n' +
        '<code>/invoice 123456789 сумма</code>\n\n' +
        `Разовое: 45 мин — ${s.price_single_45 || 12} €, 60 мин — ${s.price_single_60 || 14} €.\n` +
        'Человек должен хотя бы раз написать боту — иначе я не смогу ему отправить счёт.',
        { parse_mode: 'HTML' },
      );
    }

    const who = parts[0];
    const amount = Number(parts[1].replace(',', '.'));
    if (!(amount > 0)) return ctx.reply('Сумма должна быть числом. Пример: /invoice @anna 14');

    // Находим пользователя
    let target = null;
    if (who.startsWith('@')) {
      const { data } = await db.supabase
        .from('users').select('*').ilike('username', who.slice(1)).maybeSingle();
      target = data;
    } else if (/^\d+$/.test(who)) {
      target = await db.getUserByTgId(Number(who));
    }

    if (!target) {
      return ctx.reply(
        `Не нашла ${who} среди тех, кто писал боту.\n\n` +
        'Попроси человека открыть @' + (ctx.me?.username ?? 'бота') + ' и нажать «Старт», ' +
        'потом повтори команду. Или укажи его числовой id.',
      );
    }

    const order = await db.createOrder(target, {
      type: 'lesson', id: null,
      title: `Индивидуальный урок`,
      price_eur: amount,
    });

    // Шлём счёт клиенту
    try {
      await bot.api.sendMessage(
        target.tg_id,
        `<b>Индивидуальный урок</b>\n` +
        `К оплате: <b>${money(amount)}</b>\n\n` +
        'Выбери способ оплаты, и после перевода пришли квитанцию 🙌',
        { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
      );
    } catch (e) {
      return ctx.reply(
        'Не смогла отправить счёт — возможно, человек не запускал бота ' +
        'или заблокировал его. Пусть нажмёт «Старт» и напишет что-нибудь.',
      );
    }

    await ctx.reply(
      `Счёт отправлен: ${target.username ? '@' + target.username : target.first_name} · ${money(amount)} ✅\n` +
      'Как оплатит и пришлёт квитанцию — она придёт сюда на подтверждение.',
    );
  });

  // Отправить реквизиты без счёта — когда сумма ещё не согласована
  //   /pay @username
  bot.command('pay', async (ctx) => {
    if (!isOwner(ctx)) return;
    const who = (ctx.match ?? '').trim().split(/\s+/)[0];

    if (!who) {
      return ctx.reply(
        'Отправить реквизиты без фиксированной суммы:\n\n' +
        '<code>/pay @username</code>\n\n' +
        'Человек увидит способы оплаты и пришлёт квитанцию на любую ' +
        'сумму, которую вы обговорили. Подходит, когда цена ещё не решена.',
        { parse_mode: 'HTML' },
      );
    }

    let target = null;
    if (who.startsWith('@')) {
      const { data } = await db.supabase
        .from('users').select('*').ilike('username', who.slice(1)).maybeSingle();
      target = data;
    } else if (/^\d+$/.test(who)) {
      target = await db.getUserByTgId(Number(who));
    }

    if (!target) {
      return ctx.reply(
        `Не нашла ${who}. Пусть человек откроет бота, нажмёт «Старт», потом повтори.`,
      );
    }

    // Заказ с нулевой суммой — человек впишет свою при переводе,
    // а подтверждаешь ты по квитанции как обычно.
    const order = await db.createOrder(target, {
      type: 'lesson', id: null,
      title: 'Индивидуальный урок',
      price_eur: 0.01,
    });

    try {
      await bot.api.sendMessage(
        target.tg_id,
        `<b>Оплата занятия</b>\n\n` +
        'Выбери удобный способ оплаты. Сумму мы обговорили — ' +
        'переведи её и пришли квитанцию, я подтвержу 🙌',
        { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
      );
    } catch {
      return ctx.reply('Не смогла отправить — пусть человек нажмёт «Старт» в боте.');
    }

    await ctx.reply(
      `Реквизиты отправлены: ${target.username ? '@' + target.username : target.first_name} ✅\n` +
      'Как пришлёт квитанцию — она придёт сюда на подтверждение.',
    );
  });

  bot.command('delslots', async (ctx) => {
    if (!isOwner(ctx)) return;
    await loadTz();
    const date = (ctx.match ?? '').trim();
    if (!/^\d{1,2}\.\d{1,2}$/.test(date)) return ctx.reply('Формат: /delslots 27.07');

    const from = localToUtc(date, 0, 0).toISOString();
    const to = localToUtc(date, 23, 59).toISOString();

    const { data } = await db.supabase
      .from('slots').delete().eq('status', 'free')
      .gte('starts_at', from).lte('starts_at', to).select('id');

    await ctx.reply(`Удалено свободных слотов: ${data?.length ?? 0}`);
  });
}
