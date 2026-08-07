import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { ENV } from './config.js';

const TZ = 'Europe/Kyiv';
const uah = (n) => `${Number(n).toFixed(0)} грн`;

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function monthStart() {
  const t = today();
  return t.slice(0, 8) + '01';
}
function fmtDate(d) {
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' })
    .format(new Date(d + 'T12:00:00'));
}

function isOwner(ctx) {
  return String(ctx.from?.id) === String(ENV.OWNER_TG_ID);
}

const STATUS = {
  planned:   '🕓 запланирован',
  done:      '✅ проведён',
  cancelled: '❌ отменён',
  noshow:    '🚫 не пришёл',
};

// ---------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------
async function students() {
  const { data } = await db.supabase
    .from('tc_students').select('*').eq('is_active', true).order('name');
  return data ?? [];
}
async function ensureStudent(name) {
  const { data: ex } = await db.supabase
    .from('tc_students').select('*').ilike('name', name).maybeSingle();
  if (ex) return ex;
  const { data } = await db.supabase
    .from('tc_students').insert({ name }).select().single();
  return data;
}

// ---------------------------------------------------------------------
// Главный экран кабинета
// ---------------------------------------------------------------------
async function showCabinet(ctx) {
  const kb = new InlineKeyboard()
    .text('➕ Записать урок', 'tc:new').row()
    .text('📅 Сегодня', 'tc:today').text('📖 Уроки', 'tc:lessons').row()
    .text('💰 Записать оплату', 'tc:pay').row()
    .text('📊 За месяц', 'tc:month').text('📈 За неделю', 'tc:week').row()
    .text('💵 Оплаты', 'tc:payments').text('👤 Ученики', 'tc:students');

  await ctx.reply(
    '📚 <b>Кабинет учителя</b>\n\nВыбери, что сделать:',
    { parse_mode: 'HTML', reply_markup: kb },
  ).catch(() => {});
}

// ---------------------------------------------------------------------
export function registerTeacher(bot) {
  // Открыть кабинет — команда и кнопка
  bot.command('cab', (ctx) => { if (isOwner(ctx)) return showCabinet(ctx); });
  bot.command('kabinet', (ctx) => { if (isOwner(ctx)) return showCabinet(ctx); });
  bot.callbackQuery('tc:home', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery(); await showCabinet(ctx);
  });

  // ---------- ЗАПИСАТЬ УРОК: выбор ученика ----------
  bot.callbackQuery('tc:new', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const list = await students();
    if (!list.length) {
      const u = await db.ensureUser(ctx.from);
      await db.setState(u.id, 'tc_new_student_then_lesson', {});
      return ctx.reply('С кем урок? Напиши имя ученика — я его сразу добавлю.');
    }
    const kb = new InlineKeyboard();
    for (const s of list) kb.text(s.name, `tc:nl:${s.id}`).row();
    kb.text('➕ Новый ученик', 'tc:newstud').row();
    kb.text('← Назад', 'tc:home');
    await ctx.reply('С кем урок? Выбери или добавь нового.', { reply_markup: kb });
  });

  // Новый ученик — просим имя
  bot.callbackQuery('tc:newstud', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_newstud', {});
    await ctx.reply('Как зовут ученика? Напиши имя одним сообщением.');
  });

  // Выбрали ученика → спрашиваем время
  bot.callbackQuery(/^tc:nl:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_time', { student_id: ctx.match[1] });
    await ctx.reply('Во сколько урок? Напиши, например 16:00\n(или «-», если без времени)');
  });

  // ---------- ЗАПИСАТЬ ОПЛАТУ: выбор ученика ----------
  bot.callbackQuery('tc:pay', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const list = await students();
    if (!list.length) {
      const u = await db.ensureUser(ctx.from);
      await db.setState(u.id, 'tc_new_student_then_pay', {});
      return ctx.reply('От кого оплата? Напиши имя ученика — я его сразу добавлю.');
    }
    const kb = new InlineKeyboard();
    for (const s of list) kb.text(s.name, `tc:pl:${s.id}`).row();
    kb.text('➕ Новый ученик', 'tc:pnew').row();
    kb.text('← Назад', 'tc:home');
    await ctx.reply('От кого оплата? Выбери или добавь нового.', { reply_markup: kb });
  });

  // Новый ученик со стороны оплаты
  bot.callbackQuery('tc:pnew', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_new_student_then_pay', {});
    await ctx.reply('Напиши имя ученика — я его добавлю.');
  });

  bot.callbackQuery(/^tc:pl:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_payamount', { student_id: ctx.match[1] });
    await ctx.reply('Сколько заплатили? Напиши сумму в гривнах, например 700');
  });

  // ---------- СЕГОДНЯ ----------
  bot.callbackQuery('tc:today', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await sendToday(ctx);
  });
  bot.command('today', (ctx) => { if (isOwner(ctx)) return sendToday(ctx); });

  async function sendToday(ctx) {
    const d = today();
    const { data: lessons } = await db.supabase
      .from('tc_lessons').select('*').eq('lesson_date', d)
      .order('lesson_time', { ascending: true });

    if (!lessons?.length) {
      return ctx.reply('На сегодня уроков нет.', {
        reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home'),
      });
    }

    const kb = new InlineKeyboard();
    let txt = `📅 <b>Сегодня, ${fmtDate(d)}</b>\n\n`;
    for (const l of lessons) {
      txt += `${l.lesson_time || '—'} · ${l.student_name} · ${uah(l.price_uah)} · ${STATUS[l.status]}\n`;
      if (l.status === 'planned') {
        kb.text(`✅ ${l.student_name}`, `tc:done:${l.id}`)
          .text(`❌`, `tc:cancel:${l.id}`)
          .text(`🚫`, `tc:noshow:${l.id}`).row();
      }
    }
    kb.text('← В кабинет', 'tc:home');
    await ctx.reply(txt, { parse_mode: 'HTML', reply_markup: kb });
  }

  // Отметки статуса
  for (const [act, st] of [['done','done'],['cancel','cancelled'],['noshow','noshow']]) {
    bot.callbackQuery(new RegExp(`^tc:${act}:(.+)$`), async (ctx) => {
      if (!isOwner(ctx)) return ctx.answerCallbackQuery();
      await db.supabase.from('tc_lessons').update({ status: st }).eq('id', ctx.match[1]);
      await ctx.answerCallbackQuery({ text: STATUS[st] });
      await sendToday(ctx);
    });
  }

  // ---------- ВСЕ УРОКИ (последние) ----------
  bot.callbackQuery('tc:lessons', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const { data } = await db.supabase
      .from('tc_lessons').select('*')
      .order('lesson_date', { ascending: false }).limit(15);
    if (!data?.length) {
      return ctx.reply('Пока пусто', {
        reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
    }
    let txt = '📖 <b>Последние уроки</b>\n\nНажми 🗑, чтобы удалить запись.\n\n';
    const kb = new InlineKeyboard();
    for (const l of data) {
      txt += `${fmtDate(l.lesson_date)} ${l.lesson_time || ''} · ${l.student_name} · ${uah(l.price_uah)} · ${STATUS[l.status]}\n`;
      kb.text(`🗑 ${l.student_name} ${fmtDate(l.lesson_date)}`, `tc:dellesson:${l.id}`).row();
    }
    kb.text('← В кабинет', 'tc:home');
    await ctx.reply(txt, { parse_mode: 'HTML', reply_markup: kb });
  });

  // Удаление урока — с подтверждением
  bot.callbackQuery(/^tc:dellesson:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const { data: l } = await db.supabase
      .from('tc_lessons').select('*').eq('id', ctx.match[1]).maybeSingle();
    if (!l) return ctx.reply('Запись уже удалена.');
    const kb = new InlineKeyboard()
      .text('🗑 Да, удалить', `tc:dellesson2:${l.id}`)
      .text('Отмена', 'tc:lessons');
    await ctx.reply(
      `Удалить урок?\n${l.student_name} · ${fmtDate(l.lesson_date)} ${l.lesson_time || ''} · ${uah(l.price_uah)}`,
      { reply_markup: kb });
  });
  bot.callbackQuery(/^tc:dellesson2:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await db.supabase.from('tc_lessons').delete().eq('id', ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Удалено' });
    await ctx.reply('Урок удалён 🗑', {
      reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
  });

  // ---------- ОПЛАТЫ (список + удаление) ----------
  bot.callbackQuery('tc:payments', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const { data } = await db.supabase
      .from('tc_payments').select('*')
      .order('pay_date', { ascending: false }).limit(15);
    if (!data?.length) {
      return ctx.reply('Оплат пока нет', {
        reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
    }
    const KIND = { single: 'разовая', package: 'абонемент', other: 'другое' };
    let txt = '💰 <b>Последние оплаты</b>\n\nНажми 🗑, чтобы удалить.\n\n';
    const kb = new InlineKeyboard();
    for (const p of data) {
      txt += `${fmtDate(p.pay_date)} · ${p.student_name} · ${uah(p.amount_uah)} · ${KIND[p.kind]}\n`;
      kb.text(`🗑 ${p.student_name} ${uah(p.amount_uah)}`, `tc:delpay:${p.id}`).row();
    }
    kb.text('← В кабинет', 'tc:home');
    await ctx.reply(txt, { parse_mode: 'HTML', reply_markup: kb });
  });
  bot.callbackQuery(/^tc:delpay:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const { data: p } = await db.supabase
      .from('tc_payments').select('*').eq('id', ctx.match[1]).maybeSingle();
    if (!p) return ctx.reply('Запись уже удалена.');
    const kb = new InlineKeyboard()
      .text('🗑 Да, удалить', `tc:delpay2:${p.id}`)
      .text('Отмена', 'tc:payments');
    await ctx.reply(
      `Удалить оплату?\n${p.student_name} · ${uah(p.amount_uah)} · ${fmtDate(p.pay_date)}`,
      { reply_markup: kb });
  });
  bot.callbackQuery(/^tc:delpay2:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await db.supabase.from('tc_payments').delete().eq('id', ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Удалено' });
    await ctx.reply('Оплата удалена 🗑', {
      reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
  });

  // ---------- ОТЧЁТЫ ----------
  bot.callbackQuery('tc:month', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await report(ctx, monthStart(), today(), 'за месяц');
  });
  bot.command('month', (ctx) => { if (isOwner(ctx)) return report(ctx, monthStart(), today(), 'за месяц'); });

  bot.callbackQuery('tc:week', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const w = new Date(); w.setDate(w.getDate() - 6);
    await report(ctx, w.toISOString().slice(0, 10), today(), 'за неделю');
  });

  async function report(ctx, from, to, label) {
    const { data: lessons } = await db.supabase
      .from('tc_lessons').select('*')
      .gte('lesson_date', from).lte('lesson_date', to);
    const { data: pays } = await db.supabase
      .from('tc_payments').select('*')
      .gte('pay_date', from).lte('pay_date', to);

    const done = (lessons ?? []).filter((l) => l.status === 'done');
    const cancelled = (lessons ?? []).filter((l) => l.status === 'cancelled' || l.status === 'noshow');
    const earned = (pays ?? []).reduce((a, p) => a + Number(p.amount_uah), 0);
    const lessonSum = done.reduce((a, l) => a + Number(l.price_uah), 0);

    // по ученикам
    const byStud = {};
    for (const l of done) byStud[l.student_name] = (byStud[l.student_name] || 0) + 1;
    const studLines = Object.entries(byStud)
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `  ${n} — ${c}`).join('\n');

    await ctx.reply(
      `📊 <b>Отчёт ${label}</b>\n` +
      `${fmtDate(from)} — ${fmtDate(to)}\n\n` +
      `Проведено уроков: <b>${done.length}</b>\n` +
      `Отменено/не пришли: ${cancelled.length}\n` +
      `Сумма проведённых уроков: ${uah(lessonSum)}\n\n` +
      `💰 Получено оплат: <b>${uah(earned)}</b>\n\n` +
      (studLines ? `<b>По ученикам:</b>\n${studLines}` : ''),
      { parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') },
    );
  }

  // ---------- УЧЕНИКИ ----------
  bot.callbackQuery('tc:students', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const list = await students();
    let txt = '👤 <b>Ученики</b>\n\n';
    const kb = new InlineKeyboard();
    for (const s of list) {
      const { count } = await db.supabase.from('tc_lessons')
        .select('id', { count: 'exact', head: true })
        .eq('student_id', s.id).eq('status', 'done');
      const price = s.default_price_uah ? `${Number(s.default_price_uah).toFixed(0)} грн` : 'цена не задана';
      txt += `${s.name} — ${count ?? 0} уроков · ${price}\n`;
      kb.text(`💵 ${s.name}`, `tc:setprice:${s.id}`).row();
    }
    kb.text('➕ Новый ученик', 'tc:newstud').row();
    kb.text('← В кабинет', 'tc:home');
    await ctx.reply(txt || 'Пока никого', { parse_mode: 'HTML', reply_markup: kb });
  });

  // Изменить привычную цену ученика
  bot.callbackQuery(/^tc:setprice:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    const { data: stud } = await db.supabase
      .from('tc_students').select('name').eq('id', ctx.match[1]).single();
    await db.setState(u.id, 'tc_setprice', { student_id: ctx.match[1] });
    await ctx.reply(`Новая цена урока для ${stud.name}? Напиши сумму в гривнах.`);
  });

  // ---------- Приём текстовых ответов (состояния) ----------
  bot.on('message:text', async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    if (ctx.message.text?.startsWith('/')) return next();
    const u = await db.ensureUser(ctx.from);
    const st = u.state;
    if (!st || !st.startsWith('tc_')) return next();

    const txt = ctx.message.text.trim();

    if (st === 'tc_newstud') {
      const s = await ensureStudent(txt);
      await db.clearState(u.id);
      const kb = new InlineKeyboard()
        .text('Записать ему урок', `tc:nl:${s.id}`).row()
        .text('← В кабинет', 'tc:home');
      return ctx.reply(`Добавила ученика: ${s.name} ✅`, { reply_markup: kb });
    }

    // Новый ученик → сразу к записи урока
    if (st === 'tc_new_student_then_lesson') {
      const s = await ensureStudent(txt);
      await db.setState(u.id, 'tc_time', { student_id: s.id });
      return ctx.reply(
        `Ученик ${s.name} добавлен ✅\n\nВо сколько урок? Например 16:00 (или «-», если без времени)`,
      );
    }

    // Новый ученик → сразу к записи оплаты
    if (st === 'tc_new_student_then_pay') {
      const s = await ensureStudent(txt);
      await db.setState(u.id, 'tc_payamount', { student_id: s.id });
      return ctx.reply(
        `Ученик ${s.name} добавлен ✅\n\nСколько заплатили? Сумма в гривнах, например 700`,
      );
    }

    if (st === 'tc_time') {
      const sd = { ...u.state_data, time: txt === '-' ? null : txt };
      await db.setState(u.id, 'tc_price', sd);
      // есть ли цена по умолчанию у ученика
      const { data: stud } = await db.supabase
        .from('tc_students').select('name, default_price_uah').eq('id', sd.student_id).single();
      if (stud?.default_price_uah > 0) {
        const kb = new InlineKeyboard()
          .text(`${Number(stud.default_price_uah).toFixed(0)} грн (как обычно)`, `tc:useprice:${stud.default_price_uah}`).row()
          .text('Другая сумма', 'tc:otherprice');
        return ctx.reply(`Цена урока для ${stud.name}?`, { reply_markup: kb });
      }
      return ctx.reply('Цена урока в гривнах? Например 700\n(или «0», если бесплатно/абонемент)');
    }

    if (st === 'tc_price') {
      const price = Number(txt.replace(',', '.')) || 0;
      await saveLesson(ctx, price);
      return;
    }

    if (st === 'tc_setprice') {
      const price = Number(txt.replace(',', '.'));
      if (!(price >= 0)) return ctx.reply('Нужна сумма числом, например 700');
      const { data: stud } = await db.supabase
        .from('tc_students')
        .update({ default_price_uah: price })
        .eq('id', u.state_data.student_id).select('name').single();
      await db.clearState(u.id);
      return ctx.reply(`Готово: цена для ${stud.name} теперь ${price} грн ✅`, {
        reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home'),
      });
    }

    if (st === 'tc_payamount') {
      const amount = Number(txt.replace(',', '.'));
      if (!(amount > 0)) return ctx.reply('Нужна сумма числом, например 700');
      await db.setState(u.id, 'tc_paykind', { ...u.state_data, amount });
      const kb = new InlineKeyboard()
        .text('Разовая', 'tc:pk:single').text('Абонемент', 'tc:pk:package')
        .text('Другое', 'tc:pk:other');
      return ctx.reply('Что за оплата?', { reply_markup: kb });
    }

    return next();
  });

  // Быстрый выбор привычной цены
  bot.callbackQuery(/^tc:useprice:(\d+(?:\.\d+)?)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await saveLesson(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery('tc:otherprice', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await ctx.reply('Напиши сумму в гривнах, например 700');
  });

  // Общая функция сохранения урока
  async function saveLesson(ctx, price) {
    const u = await db.ensureUser(ctx.from);
    const { student_id, time } = u.state_data ?? {};
    const { data: stud } = await db.supabase
      .from('tc_students').select('name, default_price_uah').eq('id', student_id).single();
    await db.supabase.from('tc_lessons').insert({
      student_id, student_name: stud.name,
      lesson_date: today(), lesson_time: time, price_uah: price,
      status: 'planned',
    });
    // запоминаем цену как обычную, если её ещё не было
    if (!stud.default_price_uah && price > 0) {
      await db.supabase.from('tc_students')
        .update({ default_price_uah: price }).eq('id', student_id);
    }
    await db.clearState(u.id);
    const kb = new InlineKeyboard()
      .text('📅 Сегодня', 'tc:today').row()
      .text('← В кабинет', 'tc:home');
    await ctx.reply(
      `Записала урок: ${stud.name}${time ? ' в ' + time : ''} · ${price} грн ✅`,
      { reply_markup: kb });
  }

  // Тип оплаты → сохраняем
  bot.callbackQuery(/^tc:pk:(\w+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    const kind = ctx.match[1];
    const u = await db.ensureUser(ctx.from);
    const { student_id, amount } = u.state_data ?? {};
    if (!amount) { await ctx.answerCallbackQuery(); return; }
    const { data: stud } = await db.supabase
      .from('tc_students').select('name').eq('id', student_id).single();
    await db.supabase.from('tc_payments').insert({
      student_id, student_name: stud.name,
      amount_uah: amount, pay_date: today(), kind,
    });
    await db.clearState(u.id);
    await ctx.answerCallbackQuery({ text: 'Записано' });
    await ctx.reply(
      `Оплата записана: ${stud.name} · ${uah(amount)} ✅`,
      { reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') },
    );
  });
}

// ---------------------------------------------------------------------
// Вечернее напоминание (вызывается кроном в 21:00 Киев)
// ---------------------------------------------------------------------
export async function sendEveningReminder(bot) {
  if (!ENV.OWNER_TG_ID) return;
  const d = today();
  const { data: lessons } = await db.supabase
    .from('tc_lessons').select('*').eq('lesson_date', d);

  const planned = (lessons ?? []).filter((l) => l.status === 'planned');
  if (!planned.length) return;

  let txt = `🌙 <b>Итоги дня</b>\n\nНе отмечены уроки:\n`;
  const kb = new InlineKeyboard();
  for (const l of planned) {
    txt += `${l.lesson_time || '—'} · ${l.student_name}\n`;
    kb.text(`✅ ${l.student_name}`, `tc:done:${l.id}`).row();
  }
  kb.text('📅 Открыть день', 'tc:today');

  await bot.api.sendMessage(ENV.OWNER_TG_ID, txt, {
    parse_mode: 'HTML', reply_markup: kb,
  }).catch(() => {});
}
