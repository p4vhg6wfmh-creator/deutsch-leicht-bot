import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { ENV, PAY_METHODS } from './config.js';
import { money, escapeHtml, kbBackMain, kbPayMethods, screen } from './ui.js';

// Промежутки времени. В callback_data уходит только латинский код —
// Telegram ограничивает эти данные 64 байтами, а кириллица занимает по 2.
export const TIME_SLOTS = {
  morning:   '🌅 Утро · 9:00–12:00',
  day:       '☀️ День · 12:00–15:00',
  afternoon: '🌤 После обеда · 15:00–18:00',
  evening:   '🌙 Вечер · 18:00–21:00',
  any:       'Мне подойдёт любое',
};

// ---------------------------------------------------------------------
// Доступ к данным
// ---------------------------------------------------------------------
export async function listGroups() {
  const { data } = await db.supabase
    .from('groups_public')
    .select('*')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  return data ?? [];
}

export async function getGroup(id) {
  const { data } = await db.supabase
    .from('groups_public').select('*').eq('id', id).maybeSingle();
  return data;
}

export async function countOpenGroups() {
  const { count } = await db.supabase
    .from('groups')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', true);
  return count ?? 0;
}

async function getMember(groupId, userId) {
  const { data } = await db.supabase
    .from('group_members')
    .select('*')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle();
  return data;
}

export async function memberships(userId) {
  const { data } = await db.supabase
    .from('group_members')
    .select('*, groups(level, title, schedule_text, platform)')
    .eq('user_id', userId)
    .neq('status', 'left');
  return data ?? [];
}

// ---------------------------------------------------------------------
// Отрисовка
// ---------------------------------------------------------------------
function groupLine(g) {
  const dot = g.status !== 'recruiting' ? '⚪️' : (g.seats_left > 0 ? '🟢' : '🔴');

  // Интенсив по грамматике — своя подпись, без счётчика мест
  if (g.level === 'A1-B1') {
    return `${dot} 🎯 Интенсив по грамматике А1–Б1`;
  }

  // Обычная группа: формат + уровень + время + места
  const when = g.schedule_text || g.start_note || '';
  const seats = g.seats_left > 0 ? `${g.seats_taken} из ${g.capacity}` : 'мест нет';
  const tail = [when, seats].filter(Boolean).join(' · ');
  return `${dot} 👥 Группа ${g.level}${tail ? ' · ' + tail : ''}`;
}

export async function showGroupList(ctx) {
  const groups = await listGroups();
  const settings = await db.getSettings();
  const waitLevels = (settings.waitlist_levels || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const openLevels = new Set(groups.map((g) => g.level));

  const kb = new InlineKeyboard();
  for (const g of groups) {
    kb.text(groupLine(g), `grp:${g.id}`).row();
  }
  for (const lvl of waitLevels) {
    if (openLevels.has(lvl)) continue;
    kb.text(`⚪️ ${lvl} группа — лист ожидания`, `wl:${lvl}`).row();
  }
  kb.text('🎓 Индивидуальные уроки', 'slots:days').row();
  kb.text('💬 Разговорный клуб', 'club:show').row();
  kb.text('✍️ Связаться со мной', 'menu:contact').row();
  kb.text('← В главное меню', 'menu:main');

  const text =
    '📚 <b>Занятия с преподавателем</b>\n\n' +
    'Группы небольшие, поэтому места заканчиваются. ' +
    'Выбирай уровень — расскажу подробнее.';

  await screen(ctx, text, kb);
}

async function showGroupCard(ctx, group, prefix = '') {
  const user   = await db.ensureUser(ctx.from);
  const member = await getMember(group.id, user.id);

  const when = group.schedule_text
    ? `Расписание: <b>${escapeHtml(group.schedule_text)}</b>`
    : 'Расписание согласуем с набранной группой — спрошу у всех удобное время.';

  const text =
    `${prefix}${prefix ? '\n\n' : ''}` +
    `<b>${escapeHtml(group.title)}</b>\n\n` +
    `${group.description ?? ''}\n\n` +
    `${when}\n` +
    `Платформа: ${escapeHtml(group.platform)}\n` +
    `Стоимость: <b>${money(group.price_eur)}</b> в месяц` +
    (group.drop_in_eur ? ` · разовое ${money(group.drop_in_eur)}` : '') + `\n` +
    `Мест занято: ${group.seats_taken} из ${group.capacity}`;

  const kb = new InlineKeyboard();
  if (member && member.status !== 'left') {
    kb.text('✅ Ты уже записана(-н)', 'noop').row();
  } else if (group.status !== 'recruiting') {
    kb.text('Сообщить, когда откроется набор', `wl:${group.level}`).row();
  } else if (group.seats_left > 0) {
    kb.text('Забронировать место', `grpjoin:${group.id}`).row();
    if (group.drop_in_eur) {
      kb.text(`Разовое занятие · ${money(group.drop_in_eur)}`, `grpdrop:${group.id}`).row();
    }
  } else {
    kb.text('Мест нет — сообщить, если освободится', `wl:${group.level}`).row();
  }
  kb.text('← Назад к списку', 'menu:lessons').row();
  kb.text('☰ Главное меню', 'menu:main');

  await screen(ctx, text, kb);
}

// ---------------------------------------------------------------------
// Выставление счёта участнику (вызывается владельцем)
// ---------------------------------------------------------------------
export async function sendInvoice(bot, group, member, user) {
  const order = await db.createOrder(user, {
    type:      'cohort',
    id:        group.id,
    title:     `${group.title} — месяц`,
    price_eur: group.price_eur,
  });

  const when = group.schedule_text
    ? `Расписание: ${group.schedule_text}\n`
    : '';

  await bot.api.sendMessage(
    user.tg_id,
    `<b>${escapeHtml(group.title)}</b>\n\n` +
    when +
    `К оплате за месяц: <b>${money(group.price_eur)}</b>\n\n` +
    `Выбери удобный способ оплаты:`,
    { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
  );

  return order;
}

// ---------------------------------------------------------------------
// Выдача доступа после подтверждения оплаты
// ---------------------------------------------------------------------
export async function deliverCohort(bot, order, tgId) {
  const group = await getGroup(order.product_ref);
  const { data: user } = await db.supabase
    .from('users').select('id').eq('tg_id', tgId).single();

  const member = await getMember(group.id, user.id);

  // Продлеваем от текущей даты окончания, если она в будущем
  const base = member?.paid_until && new Date(member.paid_until) > new Date()
    ? new Date(member.paid_until)
    : new Date();
  const paidUntil = new Date(base);
  paidUntil.setMonth(paidUntil.getMonth() + 1);
  const paidUntilStr = paidUntil.toISOString().slice(0, 10);

  if (member) {
    await db.supabase
      .from('group_members')
      .update({ status: 'active', paid_until: paidUntilStr, last_reminded_at: null })
      .eq('id', member.id);
  } else {
    await db.supabase
      .from('group_members')
      .insert({
        group_id: group.id, user_id: user.id,
        status: 'active', paid_until: paidUntilStr,
      });
  }

  let text =
    `Оплата подтверждена 🎉\n\n` +
    `Ты в группе «${group.title}». Оплачено до ${paidUntilStr}.`;
  if (group.schedule_text) text += `\nРасписание: ${group.schedule_text}`;

  await bot.api.sendMessage(tgId, text);

  if (group.chat_invite_link) {
    await bot.api.sendMessage(tgId, `Чат группы: ${group.chat_invite_link}`);
  }

  // Уведомление преподавателю
  const { data: teacher } = await db.supabase
    .from('teachers').select('tg_id').eq('id', group.teacher_id).maybeSingle();
  if (teacher?.tg_id) {
    await bot.api.sendMessage(
      teacher.tg_id,
      `💰 Оплата в группе «${group.title}». Оплачено до ${paidUntilStr}.`,
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Напоминания о продлении (вызывается по расписанию)
// ---------------------------------------------------------------------
export async function runRenewalReminders(bot) {
  const settings = await db.getSettings(true);
  const days  = Number(settings.renew_remind_days || 3);
  const grace = Number(settings.grace_days || 3);

  const today = new Date();
  const soon  = new Date(today); soon.setDate(soon.getDate() + days);
  const dead  = new Date(today); dead.setDate(dead.getDate() - grace);

  const iso = (d) => d.toISOString().slice(0, 10);

  const { data: members } = await db.supabase
    .from('group_members')
    .select('*, groups(*), users(tg_id, first_name)')
    .eq('status', 'active')
    .lte('paid_until', iso(soon));

  let sent = 0;

  for (const m of members ?? []) {
    const paidUntil = new Date(m.paid_until);

    // Просрочка дольше грейса — снимаем с активных, пишем владельцу
    if (paidUntil < dead) {
      await db.supabase
        .from('group_members').update({ status: 'reserved' }).eq('id', m.id);
      await bot.api.sendMessage(
        ENV.ADMIN_CHAT_ID,
        `⚠️ ${m.users.first_name ?? 'Участник'} не продлил(а) оплату ` +
        `в группе «${m.groups.title}» (истекла ${m.paid_until}).`,
      ).catch(() => {});
      continue;
    }

    // Не напоминаем дважды в сутки
    if (m.last_reminded_at &&
        Date.now() - new Date(m.last_reminded_at).getTime() < 20 * 3600 * 1000) {
      continue;
    }

    const left = Math.ceil((paidUntil - today) / 86400000);
    const text = left > 0
      ? `Напоминаю: оплата за группу «${m.groups.title}» заканчивается ${m.paid_until}.\n\n` +
        `Продлить — ${money(m.groups.price_eur)} за следующий месяц.`
      : `Оплата за группу «${m.groups.title}» закончилась ${m.paid_until}.\n\n` +
        `Продлить — ${money(m.groups.price_eur)} за месяц.`;

    const kb = new InlineKeyboard().text('Продлить', `grprenew:${m.group_id}`);

    await bot.api.sendMessage(m.users.tg_id, text, { reply_markup: kb })
      .then(async () => {
        sent++;
        await db.supabase
          .from('group_members')
          .update({ last_reminded_at: new Date().toISOString() })
          .eq('id', m.id);
      })
      .catch(() => {});
  }

  return sent;
}

// ---------------------------------------------------------------------
// Регистрация обработчиков
// ---------------------------------------------------------------------
export function registerGroups(bot) {
  bot.callbackQuery('menu:lessons', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showGroupList(ctx);
  });

  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery());

  bot.callbackQuery(/^grp:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const group = await getGroup(ctx.match[1]);
    if (!group) return;
    await showGroupCard(ctx, group);
  });

  // --- Бронь места: спрашиваем удобное время --------------------------
  bot.callbackQuery(/^grpjoin:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const groupId = ctx.match[1];
    const group = await getGroup(groupId);
    if (!group || group.seats_left <= 0) {
      return ctx.reply('Места закончились 🙈', { reply_markup: kbBackMain() });
    }

    const kb = new InlineKeyboard();
    for (const [code, label] of Object.entries(TIME_SLOTS)) {
      kb.text(label, `grptime:${groupId}:${code}`).row();
    }

    await ctx.reply(
      'Отлично! Один вопрос, чтобы собрать расписание под группу.\n\n' +
      `Занятие длится <b>${group.lesson_length} минут</b>, два раза в неделю. ` +
      'Выбери промежуток, в который тебе удобно заниматься — ' +
      'расписание соберу по ответам всей группы.\n\n' +
      '<b>Когда тебе удобнее?</b>',
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  bot.callbackQuery(/^grptime:([^:]+):(\w+)$/, async (ctx) => {
    const [, groupId, code] = ctx.match;
    const slot = TIME_SLOTS[code] ?? code;
    const group = await getGroup(groupId);
    const user  = await db.ensureUser(ctx.from);

    if (!group || group.seats_left <= 0) {
      return ctx.answerCallbackQuery({ text: 'Места закончились', show_alert: true });
    }

    const existing = await getMember(groupId, user.id);
    if (existing && existing.status !== 'left') {
      return ctx.answerCallbackQuery({ text: 'Ты уже записана(-н)', show_alert: true });
    }

    if (existing) {
      await db.supabase.from('group_members')
        .update({ status: 'reserved', preferred_time: slot }).eq('id', existing.id);
    } else {
      await db.supabase.from('group_members').insert({
        group_id: groupId, user_id: user.id,
        status: 'reserved', preferred_time: slot,
      });
    }

    await ctx.answerCallbackQuery({ text: 'Место забронировано' });

    await ctx.reply(
      `Место в группе «${group.title}» за тобой 🎉\n\n` +
      `Оплата пока не нужна. Когда соберём группу и согласуем расписание, ` +
      `я пришлю сюда точное время и реквизиты.\n\n` +
      `Если планы поменяются — просто напиши мне.`,
      { reply_markup: kbBackMain() },
    );

    await ctx.api.sendMessage(
      ENV.ADMIN_CHAT_ID,
      `👥 <b>Новая запись в группу</b>\n\n` +
      `Группа: ${escapeHtml(group.title)}\n` +
      `Кто: ${escapeHtml(user.first_name ?? '')} ` +
      `${user.username ? '@' + user.username : `(id ${user.tg_id})`}\n` +
      `Удобное время: ${slot}\n` +
      `Занято мест: ${group.seats_taken + 1} из ${group.capacity}`,
      { parse_mode: 'HTML' },
    ).catch(() => {});
  });

  // --- Разовое занятие в группе ---------------------------------------
  bot.callbackQuery(/^grpdrop:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const group = await getGroup(ctx.match[1]);
    const user  = await db.ensureUser(ctx.from);
    if (!group || !group.drop_in_eur) return;

    const order = await db.createOrder(user, {
      type: 'cohort', id: group.id,
      title: `${group.title} — разовое занятие`,
      price_eur: group.drop_in_eur,
    });
    await ctx.reply(
      `<b>${escapeHtml(group.title)}</b> — разовое занятие\n` +
      `К оплате: <b>${money(group.drop_in_eur)}</b>\n\n` +
      'Выбери способ оплаты:',
      { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
    );
  });

  // --- Разговорный клуб -----------------------------------------------
  bot.callbackQuery('club:show', async (ctx) => {
    await ctx.answerCallbackQuery();
    const { data: club } = await db.supabase
      .from('club').select('*').eq('is_active', true).maybeSingle();
    if (!club) return ctx.reply('Клуб пока недоступен.', { reply_markup: kbBackMain() });

    const user = await db.ensureUser(ctx.from);
    const kb = new InlineKeyboard();

    if (club.is_open) {
      kb.text(`Месяц · ${money(club.price_month)}`, 'club:buy:month').row();
      kb.text(`Разовое участие · ${money(club.price_dropin)}`, 'club:buy:dropin').row();
    } else {
      kb.text('Сообщить, когда откроется', 'club:wl').row();
    }
    kb.text('← Назад', 'menu:lessons');

    await screen(ctx,
      `💬 <b>${escapeHtml(club.title)}</b>\n\n${club.description ?? ''}` +
      (club.is_open ? '' : '\n\n📭 Набор пока не открыт.'),
      kb);
  });

  bot.callbackQuery(/^club:buy:(month|dropin)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const kind = ctx.match[1];
    const { data: club } = await db.supabase.from('club').select('*').maybeSingle();
    const user = await db.ensureUser(ctx.from);
    if (!club) return;

    const price = kind === 'month' ? club.price_month : club.price_dropin;
    const title = kind === 'month' ? 'Разговорный клуб — месяц' : 'Разговорный клуб — разовое участие';

    const order = await db.createOrder(user, {
      type: kind === 'month' ? 'subscription' : 'digital',
      id: club.id, title, price_eur: price,
    });
    await ctx.reply(
      `<b>${title}</b>\nК оплате: <b>${money(price)}</b>\n\nВыбери способ оплаты:`,
      { parse_mode: 'HTML', reply_markup: kbPayMethods(order.id) },
    );
  });

  bot.callbackQuery('club:wl', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('waitlist')
      .upsert({ user_id: user.id, level: 'CLUB' }, { onConflict: 'user_id,level' });
    await ctx.reply('Записала — напишу, как только откроем клуб 💬',
      { reply_markup: kbBackMain() });
    await ctx.api.sendMessage(ENV.ADMIN_CHAT_ID,
      `💬 Лист ожидания КЛУБ: ${escapeHtml(user.first_name ?? '')} ` +
      `${user.username ? '@' + user.username : ''}`).catch(() => {});
  });

  // --- Продление ------------------------------------------------------
  bot.callbackQuery(/^grprenew:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const group = await getGroup(ctx.match[1]);
    const user  = await db.ensureUser(ctx.from);
    if (!group) return;
    await sendInvoice(bot, group, null, user);
  });

  // --- Лист ожидания --------------------------------------------------
  bot.callbackQuery(/^wl:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const level = ctx.match[1];
    const user  = await db.ensureUser(ctx.from);

    await db.supabase
      .from('waitlist')
      .upsert({ user_id: user.id, level }, { onConflict: 'user_id,level' });

    const { count } = await db.supabase
      .from('waitlist')
      .select('id', { count: 'exact', head: true })
      .eq('level', level);

    await ctx.reply(
      `Записала тебя в лист ожидания на <b>${escapeHtml(level)}</b> ✍️\n\n` +
      `Сейчас в списке ${count ?? 1} чел. Как только наберётся группа — ` +
      `напишу сюда первой(-ым), до всякой рекламы.`,
      { parse_mode: 'HTML', reply_markup: kbBackMain() },
    );

    await ctx.api.sendMessage(
      ENV.ADMIN_CHAT_ID,
      `📝 Лист ожидания ${level}: ${escapeHtml(user.first_name ?? '')} ` +
      `${user.username ? '@' + user.username : ''} · всего ${count ?? 1}`,
      { parse_mode: 'HTML' },
    ).catch(() => {});
  });

  // -------------------------------------------------------------------
  // АДМИНКА: /groups — список, участники, выставить счёт
  // -------------------------------------------------------------------
  bot.command('groups', async (ctx) => {
    if (!isOwner(ctx)) return;
    const groups = await listGroups();
    if (!groups.length) return ctx.reply('Групп пока нет.');

    const kb = new InlineKeyboard();
    for (const g of groups) {
      kb.text(`${g.level} · ${g.seats_taken}/${g.capacity}`, `agrp:${g.id}`).row();
    }
    await ctx.reply('Твои группы:', { reply_markup: kb });
  });

  bot.callbackQuery(/^agrp:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const group = await getGroup(ctx.match[1]);

    const { data: members } = await db.supabase
      .from('group_members')
      .select('*, users(tg_id, first_name, username)')
      .eq('group_id', group.id)
      .neq('status', 'left');

    const lines = (members ?? []).map((m) => {
      const mark = m.status === 'active' ? '✅' : '⏳';
      const paid = m.paid_until ? ` · до ${m.paid_until}` : '';
      const who  = m.users.username ? '@' + m.users.username : (m.users.first_name ?? '—');
      return `${mark} ${who} · ${m.preferred_time ?? '—'}${paid}`;
    });

    const kb = new InlineKeyboard()
      .text('💸 Выставить счёт всем неоплатившим', `ainv:${group.id}`);

    await ctx.reply(
      `<b>${escapeHtml(group.title)}</b>\n` +
      `Расписание: ${escapeHtml(group.schedule_text || 'не задано')}\n` +
      `Занято: ${group.seats_taken} из ${group.capacity}\n\n` +
      (lines.length ? lines.join('\n') : 'Пока никого'),
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  bot.callbackQuery(/^ainv:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery({ text: 'Отправляю счета…' });

    const group = await getGroup(ctx.match[1]);
    const { data: members } = await db.supabase
      .from('group_members')
      .select('*, users(*)')
      .eq('group_id', group.id)
      .eq('status', 'reserved');

    let sent = 0;
    for (const m of members ?? []) {
      await sendInvoice(bot, group, m, m.users).then(() => sent++).catch(() => {});
    }

    await ctx.reply(`Счета отправлены: ${sent}`);
  });
}

function isOwner(ctx) {
  return !ENV.OWNER_TG_ID || String(ctx.from?.id) === String(ENV.OWNER_TG_ID);
}
