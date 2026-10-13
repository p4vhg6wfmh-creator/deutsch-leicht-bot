import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { ENV } from './config.js';
import { parseMessage } from './ai.js';

const TZ = 'Europe/Kyiv';
const uah = (n) => `${Number(n).toFixed(0)} грн`;

function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function tomorrow() {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + 1);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
}
// принимает «25.12» или «25.12.2025» → «2025-12-25», иначе null
function parseDate(s) {
  const m = s.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?$/);
  if (!m) return null;
  const day = m[1].padStart(2, '0');
  const mon = m[2].padStart(2, '0');
  let year = m[3] || today().slice(0, 4);
  if (year.length === 2) year = '20' + year;
  return `${year}-${mon}-${day}`;
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

// Реквизиты для оплаты (показываем ученику, если абонемент закончился)
const PAY_DETAILS =
  `💳 <b>Оплата (в EUR):</b>\n` +
  `Карта Monobank: <code>4441114490605761</code>\n` +
  `PayPal: bangelina208@gmail.com\n` +
  `SEPA / IBAN: <code>GB75CLJU00997185757146</code>\n` +
  `BIC: CLJUGB21\n` +
  `Получатель: BAZYLEVSKA ANHELINA\n\n` +
  `После оплаты пришлите, пожалуйста, квитанцию 🙌`;

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
    .text('📅 Сегодня', 'tc:today').text('📆 Завтра', 'tc:tomorrow').row()
    .text('📖 Уроки', 'tc:lessons').row()
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

  // Выбрали ученика → спрашиваем ДАТУ
  bot.callbackQuery(/^tc:nl:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_date', { student_id: ctx.match[1] });
    const kb = new InlineKeyboard()
      .text('Сегодня', 'tc:date:today').text('Завтра', 'tc:date:tomorrow').row()
      .text('Другая дата', 'tc:date:other');
    await ctx.reply('На какой день урок?', { reply_markup: kb });
  });

  // Выбор даты кнопками
  bot.callbackQuery('tc:date:today', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await askTime(ctx, today());
  });
  bot.callbackQuery('tc:date:tomorrow', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await askTime(ctx, tomorrow());
  });
  bot.callbackQuery('tc:date:other', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_otherdate', u.state_data);
    await ctx.reply('Напиши дату в формате ДД.ММ, например 25.12');
  });

  // сохраняет выбранную дату/ученика в state и переходит к вопросу о времени
  async function askTime(ctx, date, studentId = null) {
    const u = await db.ensureUser(ctx.from);
    const base = studentId
      ? { student_id: studentId }
      : (u.state_data ?? {});
    await db.setState(u.id, 'tc_time', { ...base, date });
    await ctx.reply(
      `Дата: ${fmtDate(date)}.\nВо сколько урок? Напиши, например 16:00\n(или «-», если без времени)`,
    );
  }

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
    await sendDay(ctx, today(), 'Сегодня');
  });
  bot.command('today', (ctx) => { if (isOwner(ctx)) return sendDay(ctx, today(), 'Сегодня'); });

  bot.callbackQuery('tc:tomorrow', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await sendDay(ctx, tomorrow(), 'Завтра');
  });

  // Показывает уроки за конкретный день (сегодня или завтра)
  async function sendDay(ctx, d, label) {
    const isTomorrow = label === 'Завтра';
    const { data: lessons } = await db.supabase
      .from('tc_lessons').select('*').eq('lesson_date', d)
      .order('lesson_time', { ascending: true });
    const kb = new InlineKeyboard();
    let txt = `📅 <b>${label}, ${fmtDate(d)}</b>\n\n`;
    if (!lessons?.length) {
      txt += 'Уроков пока нет.\n';
    } else {
      for (const l of lessons) {
        const payMark = l.ask_payment ? ' 💳' : '';
        txt += `${l.lesson_time || '—'} · ${l.student_name} · ${uah(l.price_uah)}${payMark} · ${STATUS[l.status]}\n`;
        if (l.status === 'planned') {
          kb.text(`✅ ${l.student_name}`, `tc:done:${l.id}`)
            .text(`❌`, `tc:cancel:${l.id}`)
            .text(`🚫`, `tc:noshow:${l.id}`).row();
          kb.text(`🔔 Напомнить ${l.student_name}`, `tc:remind:${l.id}`).row();
        }
      }
    }
    // кнопка добавления урока на нужный день
    kb.text(isTomorrow ? '➕ Урок на завтра' : '➕ Урок на сегодня',
            isTomorrow ? 'tc:addfor:tomorrow' : 'tc:addfor:today').row();
    kb.text('← В кабинет', 'tc:home');
    await ctx.reply(txt, { parse_mode: 'HTML', reply_markup: kb });
  }

  // Быстрое добавление урока с уже выбранным днём (минуем вопрос про дату)
  bot.callbackQuery(/^tc:addfor:(today|tomorrow)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const day = ctx.match[1];                 // today | tomorrow
    const list = await students();
    const kb = new InlineKeyboard();
    for (const s of list) kb.text(s.name, `tc:nlday:${day}:${s.id}`).row();
    kb.text('➕ Новый ученик', 'tc:newstud').row();
    kb.text('← Назад', day === 'tomorrow' ? 'tc:tomorrow' : 'tc:today');
    const when = day === 'tomorrow' ? 'завтра' : 'сегодня';
    await ctx.reply(`С кем урок ${when}? Выбери ученика.`, { reply_markup: kb });
  });

  // Выбрали ученика для конкретного дня → сразу к времени (дату уже знаем)
  bot.callbackQuery(/^tc:nlday:(today|tomorrow):(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const day = ctx.match[1];
    const date = day === 'tomorrow' ? tomorrow() : today();
    await askTime(ctx, date, ctx.match[2]);
  });

  // Отметки статуса
  for (const [act, st] of [['done','done'],['cancel','cancelled'],['noshow','noshow']]) {
    bot.callbackQuery(new RegExp(`^tc:${act}:(.+)$`), async (ctx) => {
      if (!isOwner(ctx)) return ctx.answerCallbackQuery();
      // берём урок ДО обновления, чтобы не списать дважды
      const { data: les } = await db.supabase
        .from('tc_lessons').select('*').eq('id', ctx.match[1]).maybeSingle();
      await db.supabase.from('tc_lessons').update({ status: st }).eq('id', ctx.match[1]);
      // Списываем из абонемента только при переходе в «проведён»
      let extra = '';
      if (st === 'done' && les && les.status !== 'done' && les.student_id) {
        const { data: stud } = await db.supabase
          .from('tc_students').select('name, package_left').eq('id', les.student_id).single();
        if (stud && stud.package_left > 0) {
          const left = stud.package_left - 1;
          await db.supabase.from('tc_students')
            .update({ package_left: left }).eq('id', les.student_id);
          extra = left > 0
            ? ` · абонемент: осталось ${left}`
            : ` · абонемент закончился ⚠️`;
        }
      }
      await ctx.answerCallbackQuery({ text: STATUS[st] + extra });
      // вернуться на тот день, к которому относится урок
      if (les?.lesson_date === tomorrow()) await sendDay(ctx, tomorrow(), 'Завтра');
      else await sendDay(ctx, today(), 'Сегодня');
    });
  }

  // ---------- 🔔 РУЧНОЕ НАПОМИНАНИЕ ОДНОМУ УЧЕНИКУ ----------
  bot.callbackQuery(/^tc:remind:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    const { data: l } = await db.supabase
      .from('tc_lessons').select('*').eq('id', ctx.match[1]).maybeSingle();
    if (!l) return ctx.answerCallbackQuery({ text: 'Урок не найден' });
    if (!l.student_id) return ctx.answerCallbackQuery({ text: 'Ученик не привязан' });

    const { data: stud } = await db.supabase
      .from('tc_students').select('tg_id, name').eq('id', l.student_id).single();
    if (!stud?.tg_id) {
      return ctx.answerCallbackQuery({ text: `${l.student_name} не привязан(а) 🔗` });
    }

    const dayWord = l.lesson_date === tomorrow() ? 'завтра'
                  : l.lesson_date === today() ? 'сегодня'
                  : fmtDate(l.lesson_date);
    const when = l.lesson_time ? `${dayWord} в ${l.lesson_time}` : dayWord;
    let txt = `👋 Привет! Напоминаю: у тебя урок ${when}.`;
    if (l.ask_payment) txt += `\n\n${PAY_DETAILS}`;

    const ok = await bot.api.sendMessage(stud.tg_id, txt, { parse_mode: 'HTML' })
      .then(() => true).catch(() => false);

    await ctx.answerCallbackQuery({
      text: ok ? `Напоминание отправлено ${stud.name} ✅` : 'Не удалось отправить',
    });
  });

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
      const pack = s.package_left > 0 ? ` · 🎟 абонемент: ${s.package_left}` : '';
      const linked = s.tg_id ? ' · 🔗 привязан' : '';
      txt += `${s.name} — ${count ?? 0} уроков · ${price}${pack}${linked}\n`;
      kb.text(`📋 ${s.name}`, `tc:card:${s.id}`)
        .text('💵', `tc:setprice:${s.id}`)
        .text(s.tg_id ? '🔗✅' : '🔗', `tc:link:${s.id}`).row();
    }
    kb.text('➕ Новый ученик', 'tc:newstud').row();
    kb.text('← В кабинет', 'tc:home');
    await ctx.reply(txt || 'Пока никого', { parse_mode: 'HTML', reply_markup: kb });
  });

  // ---------- КАРТОЧКА УЧЕНИКА (уроки + оплаты за 3 месяца) ----------
  bot.callbackQuery(/^tc:card:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const id = ctx.match[1];

    // дата «3 месяца назад»
    const from = new Date();
    from.setMonth(from.getMonth() - 3);
    const fromStr = from.toISOString().slice(0, 10);

    const { data: stud } = await db.supabase
      .from('tc_students').select('*').eq('id', id).single();
    const { data: lessons } = await db.supabase
      .from('tc_lessons').select('*')
      .eq('student_id', id).gte('lesson_date', fromStr)
      .order('lesson_date', { ascending: false }).order('lesson_time', { ascending: false });
    const { data: pays } = await db.supabase
      .from('tc_payments').select('*')
      .eq('student_id', id).gte('pay_date', fromStr)
      .order('pay_date', { ascending: false });

    const ls = lessons ?? [];
    const ps = pays ?? [];
    const done = ls.filter((l) => l.status === 'done').length;
    const missed = ls.filter((l) => l.status === 'cancelled' || l.status === 'noshow').length;
    const paidSum = ps.reduce((a, p) => a + Number(p.amount_uah), 0);

    const price = stud.default_price_uah
      ? `${Number(stud.default_price_uah).toFixed(0)} грн` : 'не задана';
    const pack = stud.package_left > 0 ? `\n🎟 Абонемент: осталось ${stud.package_left}` : '';
    const linked = stud.tg_id ? '🔗 привязан' : '🔗 не привязан';

    let txt = `📋 <b>${stud.name}</b>\n`;
    txt += `${linked} · цена ${price}${pack}\n`;
    txt += `\n<b>За 3 месяца:</b>\n`;
    txt += `Проведено уроков: ${done} · пропущено/отменено: ${missed}\n`;
    txt += `Всего внесено оплат: ${uah(paidSum)}\n`;

    txt += `\n<b>📖 Уроки:</b>\n`;
    if (!ls.length) {
      txt += 'нет за этот период\n';
    } else {
      for (const l of ls) {
        txt += `${fmtDate(l.lesson_date)} ${l.lesson_time || '—'} · ${uah(l.price_uah)} · ${STATUS[l.status]}\n`;
      }
    }

    txt += `\n<b>💰 Оплаты:</b>\n`;
    if (!ps.length) {
      txt += 'нет за этот период\n';
    } else {
      const KIND = { single: 'разовая', package: 'абонемент', other: 'другое' };
      for (const p of ps) {
        txt += `${fmtDate(p.pay_date)} · ${uah(p.amount_uah)} · ${KIND[p.kind] || p.kind}\n`;
      }
    }

    const kb = new InlineKeyboard()
      .text('← К ученикам', 'tc:students')
      .text('🏠 В кабинет', 'tc:home');
    // Telegram лимит ~4096 символов — на всякий случай подрежем
    if (txt.length > 3900) txt = txt.slice(0, 3900) + '\n…(список длинный, показана часть)';
    await ctx.reply(txt, { parse_mode: 'HTML', reply_markup: kb });
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

  // ---------- ПРИВЯЗКА: владелец жмёт «🔗» и вводит ник ученика ----------
  bot.callbackQuery(/^tc:link:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const { data: stud } = await db.supabase
      .from('tc_students').select('name, tg_id').eq('id', ctx.match[1]).single();

    if (stud.tg_id) {
      const kb = new InlineKeyboard()
        .text('🔓 Отвязать', `tc:unlink:${ctx.match[1]}`)
        .text('← В кабинет', 'tc:home');
      return ctx.reply(`${stud.name} уже привязан(а) ✅`, { reply_markup: kb });
    }

    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_linknick', { student_id: ctx.match[1] });
    await ctx.reply(
      `Напиши @ник ученика «${stud.name}» (тот, под которым он писал боту).\n` +
      `Можно с @ или без.`,
    );
  });

  // Отвязать (если ученик сменил аккаунт)
  bot.callbackQuery(/^tc:unlink:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await db.supabase.from('tc_students')
      .update({ tg_id: null }).eq('id', ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Отвязано' });
    await ctx.reply('Готово, ученик отвязан. Можно привязать заново.', {
      reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
  });

  // ---------- Приём текстовых ответов (состояния) ----------
  bot.on('message:text', async (ctx, next) => {
    if (!isOwner(ctx)) return next();
    if (ctx.message.text?.startsWith('/')) return next();
    const u = await db.ensureUser(ctx.from);
    const st = u.state;
    // свободный текст владельца (без активного сценария) → ИИ-помощник
    if ((!st || st === 'tc_ai_confirm') && ctx.chat.type === 'private') return handleAI(ctx, u);
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

    // Привязка ученика по нику
    if (st === 'tc_linknick') {
      const uname = txt.replace(/^@/, '').trim();
      const { data: person } = await db.supabase
        .from('users').select('tg_id, first_name, username')
        .ilike('username', uname).maybeSingle();
      if (!person) {
        return ctx.reply(
          `Не нашла @${uname} в базе бота.\n` +
          `Значит, этот человек боту ещё не писал (/start). ` +
          `Проверь ник или попроси его написать боту.`,
        );
      }
      const { data: stud } = await db.supabase
        .from('tc_students')
        .update({ tg_id: person.tg_id })
        .eq('id', u.state_data.student_id).select('name').single();
      await db.clearState(u.id);
      return ctx.reply(
        `Готово! ${stud.name} привязан(а) к @${uname} ✅\n` +
        `Теперь бот будет присылать ему напоминания.`,
        { reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') },
      );
    }
    // Новый ученик → сразу к выбору даты урока
    if (st === 'tc_new_student_then_lesson') {
      const s = await ensureStudent(txt);
      await db.setState(u.id, 'tc_date', { student_id: s.id });
      const kb = new InlineKeyboard()
        .text('Сегодня', 'tc:date:today').text('Завтра', 'tc:date:tomorrow').row()
        .text('Другая дата', 'tc:date:other');
      return ctx.reply(`Ученик ${s.name} добавлен ✅\n\nНа какой день урок?`, { reply_markup: kb });
    }
    // Ручной ввод даты «ДД.ММ»
    if (st === 'tc_otherdate') {
      const date = parseDate(txt);
      if (!date) return ctx.reply('Не поняла дату. Напиши в формате ДД.ММ, например 25.12');
      await db.setState(u.id, 'tc_time', { ...u.state_data, date });
      return ctx.reply(
        `Дата: ${fmtDate(date)}.\nВо сколько урок? Напиши, например 16:00\n(или «-», если без времени)`,
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
      await db.setState(u.id, 'tc_askpay', { ...u.state_data, price });
      const kb = new InlineKeyboard()
        .text('💳 Да, просить', 'tc:askpay:yes')
        .text('Нет', 'tc:askpay:no');
      return ctx.reply('Просить у ученика оплату за этот урок?', { reply_markup: kb });
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
    if (st === 'tc_packcount') {
      const count = parseInt(txt, 10);
      if (!(count > 0)) return ctx.reply('Нужно число уроков, например 10');
      const { student_id, amount } = u.state_data;
      const { data: stud } = await db.supabase
        .from('tc_students').select('name, package_left').eq('id', student_id).single();
      await db.supabase.from('tc_payments').insert({
        student_id, student_name: stud.name,
        amount_uah: amount, pay_date: today(), kind: 'package',
        note: `абонемент ${count} уроков`,
      });
      // добавляем уроки к остатку (если старый абонемент не закончился — плюсуем)
      await db.supabase.from('tc_students').update({
        package_left: (stud.package_left || 0) + count,
        package_total: count,
      }).eq('id', student_id);
      await db.clearState(u.id);
      return ctx.reply(
        `Абонемент записан: ${stud.name} · ${uah(amount)} · ${count} уроков ✅\n` +
        `Теперь на балансе: ${(stud.package_left || 0) + count} уроков.`,
        { reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
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
    if (st === 'tc_rcptask') {
      const { data: stud } = await db.supabase
        .from('tc_students').select('name, tg_id').eq('id', u.state_data.student_id).single();
      await db.clearState(u.id);
      if (stud?.tg_id) {
        await bot.api.sendMessage(stud.tg_id, `📩 По оплате: ${txt}`).catch(() => {});
        return ctx.reply(`Отправила ${stud.name}: «${txt}» ✅`, {
          reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
      }
      return ctx.reply('Не смогла отправить — ученик не привязан.', {
        reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
    }
    return next();
  });
  bot.callbackQuery(/^tc:useprice:(\d+(?:\.\d+)?)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_askpay', { ...u.state_data, price: Number(ctx.match[1]) });
    const kb = new InlineKeyboard()
      .text('💳 Да, просить', 'tc:askpay:yes')
      .text('Нет', 'tc:askpay:no');
    await ctx.reply('Просить у ученика оплату за этот урок?', { reply_markup: kb });
  });
  bot.callbackQuery('tc:otherprice', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await ctx.reply('Напиши сумму в гривнах, например 700');
  });

  // Ответ на «Просить оплату?» → сохраняем урок
  bot.callbackQuery(/^tc:askpay:(yes|no)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    const price = u.state_data?.price ?? 0;
    await saveLesson(ctx, price, ctx.match[1] === 'yes');
  });

  // Общая функция сохранения урока
  async function saveLesson(ctx, price, askPayment = false) {
    const u = await db.ensureUser(ctx.from);
    const { student_id, time, date } = u.state_data ?? {};
    const lessonDate = date || today();
    const { data: stud } = await db.supabase
      .from('tc_students').select('name, default_price_uah').eq('id', student_id).single();
    await db.supabase.from('tc_lessons').insert({
      student_id, student_name: stud.name,
      lesson_date: lessonDate, lesson_time: time, price_uah: price,
      status: 'planned', ask_payment: askPayment,
    });
    // запоминаем цену как обычную, если её ещё не было
    if (!stud.default_price_uah && price > 0) {
      await db.supabase.from('tc_students')
        .update({ default_price_uah: price }).eq('id', student_id);
    }
    await db.clearState(u.id);
    const isTom = lessonDate === tomorrow();
    const kb = new InlineKeyboard();
    if (isTom) {
      kb.text('➕ Ещё на завтра', 'tc:addfor:tomorrow').row()
        .text('📆 Расписание на завтра', 'tc:tomorrow').row();
    } else {
      kb.text('➕ Ещё на сегодня', 'tc:addfor:today').row()
        .text('📅 Сегодня', 'tc:today').row();
    }
    kb.text('← В кабинет', 'tc:home');
    const payNote = askPayment ? ' · 💳 попрошу оплату' : '';
    await ctx.reply(
      `Записала урок: ${stud.name} · ${fmtDate(lessonDate)}${time ? ' в ' + time : ''} · ${price} грн${payNote} ✅`,
      { reply_markup: kb });
  }

  // Тип оплаты → сохраняем
  bot.callbackQuery(/^tc:pk:(\w+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    const kind = ctx.match[1];
    const u = await db.ensureUser(ctx.from);
    const { student_id, amount } = u.state_data ?? {};
    if (!amount) { await ctx.answerCallbackQuery(); return; }
    // Абонемент — спрашиваем количество уроков перед сохранением
    if (kind === 'package') {
      await db.setState(u.id, 'tc_packcount', { student_id, amount });
      await ctx.answerCallbackQuery();
      return ctx.reply('Сколько уроков в абонементе? Напиши число, например 10');
    }
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

  // ---------- КВИТАНЦИЯ ОТ УЧЕНИКА (фото/файл) ----------
  // Ловим фото/документ. Если отправитель — привязанный ученик и у него нет
  // активного состояния покупки — пересылаем квитанцию владельцу на проверку.
  bot.on(['message:photo', 'message:document'], async (ctx, next) => {
    // владельца и админ-чат не трогаем
    if (isOwner(ctx)) return next();
    const u = await db.ensureUser(ctx.from);
    // пропускаем дальше только если ученик прямо сейчас покупает минибук
    // (его квитанцию обработает payment.js). Любые другие «зависшие»
    // состояния квитанцию НЕ блокируют.
    if (u.state === 'awaiting_receipt') return next();

    // это привязанный ученик?
    const { data: stud } = await db.supabase
      .from('tc_students').select('id, name').eq('tg_id', ctx.from.id).maybeSingle();
    if (!stud) return next();              // не наш ученик — пропускаем дальше

    const fileId = ctx.message.document?.file_id ?? ctx.message.photo?.at(-1)?.file_id;
    if (!fileId) return next();

    // ответ ученику
    await ctx.reply('Квитанция отправлена ✅ Спасибо! Проверю оплату и напишу.');

    // отправляем владельцу саму квитанцию + кнопки
    if (!ENV.OWNER_TG_ID) return;
    const caption = `🧾 <b>Квитанция от ${stud.name}</b>\nПроверь оплату 👇`;
    const kb = new InlineKeyboard()
      .text('✅ Оплата пришла', `tc:rcpt:ok:${stud.id}`)
      .text('✏️ Уточнить', `tc:rcpt:ask:${stud.id}`);
    const opts = { caption, parse_mode: 'HTML', reply_markup: kb };
    await bot.api.sendDocument(ENV.OWNER_TG_ID, fileId, opts).catch(async () => {
      await bot.api.sendPhoto(ENV.OWNER_TG_ID, fileId, opts).catch(() => {});
    });
  });

  // Владелец нажал «Оплата пришла» → сообщаем ученику
  bot.callbackQuery(/^tc:rcpt:ok:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery({ text: 'Ученику отправлено «принято»' });
    const { data: stud } = await db.supabase
      .from('tc_students').select('name, tg_id').eq('id', ctx.match[1]).single();
    if (stud?.tg_id) {
      await bot.api.sendMessage(stud.tg_id, 'Оплата получена, спасибо! 🙌').catch(() => {});
    }
    await ctx.reply(
      `✅ ${stud.name}: подтвердила оплату.\nНе забудь записать оплату в кабинет (💰), если нужно.`,
      { reply_markup: new InlineKeyboard().text('💰 Записать оплату', 'tc:pay')
          .text('← В кабинет', 'tc:home') },
    );
  });

  // Владелец нажал «Уточнить» → просим текст, отправим ученику
  bot.callbackQuery(/^tc:rcpt:ask:(.+)$/, async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    await db.setState(u.id, 'tc_rcptask', { student_id: ctx.match[1] });
    await ctx.reply('Что написать ученику по квитанции? Напиши сообщение — я перешлю ему.');
  });

  // ======================================================================
  // 🤖 ИИ-ПОМОЩНИК: свободный текст → команды → «Верно?» → запись
  // ======================================================================
  const AI_KIND = { single: 'разовая', package: 'абонемент', other: 'другое' };
  const PACK_DEFAULT = 10;
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
  const cleanTime = (t) => (/^\d{1,2}:\d{2}$/.test(String(t ?? '')) ? String(t) : null);
  const aiWhen = (date, time) => `${fmtDate(date)}${time ? ' в ' + time : ''}`;

  async function findStudent(name) {
    const safe = String(name ?? '').trim().replace(/[%_]/g, '\\$&');
    if (!safe) return null;
    const { data } = await db.supabase
      .from('tc_students').select('*').ilike('name', safe).limit(1);
    return data?.[0] ?? null;
  }

  async function lessonsOf(studentId, date) {
    const { data } = await db.supabase
      .from('tc_lessons').select('*')
      .eq('student_id', studentId).eq('lesson_date', date).order('lesson_time');
    return data ?? [];
  }

  // Списать 1 урок из абонемента (так же, как при кнопке «проведён»)
  async function consumePackage(studentId) {
    const { data: s } = await db.supabase
      .from('tc_students').select('package_left').eq('id', studentId).single();
    if (!s || !(s.package_left > 0)) return '';
    const left = s.package_left - 1;
    await db.supabase.from('tc_students').update({ package_left: left }).eq('id', studentId);
    return left > 0 ? ` · абонемент: осталось ${left}` : ' · абонемент закончился ⚠️';
  }

  // Проверка команды ИИ + понятная строка для «Верно?». Ничего не пишет в базу.
  // Возвращает { ok, line, a } или null (если команду надо пропустить).
  async function prepare(a) {
    const name = String(a?.student ?? '').trim();
    const warn = (t) => ({ ok: false, line: `⚠️ ${t}` });
    const needName = () => warn('Не поняла, о ком речь в одном из пунктов.');

    switch (a?.type) {
      case 'report': {
        const period = ['today', 'week', 'month'].includes(a.period) ? a.period : 'week';
        const label = { today: 'за сегодня', week: 'за неделю', month: 'за месяц' }[period];
        return { ok: true, a: { type: 'report', period }, line: `📊 Показать отчёт ${label}` };
      }

      case 'add_lesson': {
        if (!name) return needName();
        if (!isDate(a.date)) return warn(`${name}: не поняла дату урока.`);
        const status = ['planned', 'done', 'cancelled', 'noshow'].includes(a.status) ? a.status : 'planned';
        const stud = await findStudent(name);
        // Урок уже есть и мы просто меняем статус → это отметка, а не новая запись
        if (stud && status !== 'planned' && (await lessonsOf(stud.id, a.date)).length) {
          return prepare({ type: 'set_status', student: stud.name, date: a.date, status });
        }
        const time = cleanTime(a.time);
        const price = a.price != null && Number(a.price) >= 0
          ? Number(a.price) : (Number(stud?.default_price_uah) || 0);
        const who = stud ? stud.name : `${name} (новый ученик)`;
        return {
          ok: true,
          a: { type: 'add_lesson', student: stud?.name ?? name, date: a.date, time, status, price },
          line: `➕ Урок: ${who} · ${aiWhen(a.date, time)} · ${STATUS[status]} · ${uah(price)}`,
        };
      }

      case 'set_status': {
        if (!name) return needName();
        if (!isDate(a.date) || !['done', 'cancelled', 'noshow'].includes(a.status)) {
          return warn(`${name}: не поняла дату или статус.`);
        }
        const stud = await findStudent(name);
        if (!stud) return warn(`Не нашла ученика «${name}». Напиши имя как в списке.`);
        const ls = await lessonsOf(stud.id, a.date);
        // урока на этот день нет → записываем новый сразу с этим статусом
        if (!ls.length) {
          return prepare({ type: 'add_lesson', student: stud.name, date: a.date, time: null, status: a.status, price: null });
        }
        const target = ls.find((l) => l.status !== a.status);
        if (!target) return warn(`${stud.name}, ${fmtDate(a.date)}: уже отмечено «${STATUS[a.status]}».`);
        let extra = '';
        if (a.status === 'done' && stud.package_left > 0) {
          extra = ` · спишу 1 из абонемента (останется ${stud.package_left - 1})`;
        }
        return {
          ok: true,
          a: { type: 'set_status', student: stud.name, status: a.status, lessonId: target.id },
          line: `${STATUS[a.status]}: ${stud.name}, ${aiWhen(a.date, target.lesson_time)}${extra}`,
        };
      }

      case 'add_payment': {
        if (!name) return needName();
        const kind = ['single', 'package', 'other'].includes(a.kind) ? a.kind : 'single';
        const stud = await findStudent(name);
        let amount = a.amount != null ? Number(a.amount) : 0;
        let usual = false;
        if (!(amount > 0) && kind === 'single' && stud?.default_price_uah > 0) {
          amount = Number(stud.default_price_uah); usual = true;
        }
        if (!(amount > 0)) {
          return warn(`${name}: не названа сумма оплаты. Напиши, например: «${name} оплатила 700».`);
        }
        const lessons = kind === 'package'
          ? (Number(a.lessons) > 0 ? Math.round(Number(a.lessons)) : PACK_DEFAULT) : null;
        const who = stud ? stud.name : `${name} (новый ученик)`;
        const tail = kind === 'package'
          ? ` · ${lessons} уроков${Number(a.lessons) > 0 ? '' : ' (по умолчанию)'}` : '';
        return {
          ok: true,
          a: { type: 'add_payment', student: stud?.name ?? name, amount, kind, lessons },
          line: `💰 Оплата: ${who} · ${uah(amount)}${usual ? ' (обычная цена)' : ''} · ${AI_KIND[kind]}${tail}`,
        };
      }

      case 'delete_lesson': {
        if (!name) return needName();
        if (!isDate(a.date)) return warn(`${name}: не поняла дату урока для удаления.`);
        const stud = await findStudent(name);
        if (!stud) return warn(`Не нашла ученика «${name}».`);
        const ls = await lessonsOf(stud.id, a.date);
        if (!ls.length) return warn(`У ${stud.name} нет урока ${fmtDate(a.date)}.`);
        if (ls.length > 1) {
          return warn(`У ${stud.name} несколько уроков ${fmtDate(a.date)} — удали нужный через 📖 Уроки.`);
        }
        const note = ls[0].status === 'done' ? ' · остаток абонемента не изменится' : '';
        return {
          ok: true,
          a: { type: 'delete_lesson', student: stud.name, lessonId: ls[0].id },
          line: `🗑 Удалить урок: ${stud.name}, ${aiWhen(a.date, ls[0].lesson_time)} · ${STATUS[ls[0].status]}${note}`,
        };
      }

      case 'delete_last_payment': {
        if (!name) return needName();
        const stud = await findStudent(name);
        if (!stud) return warn(`Не нашла ученика «${name}».`);
        const { data } = await db.supabase
          .from('tc_payments').select('*').eq('student_id', stud.id)
          .order('pay_date', { ascending: false }).limit(1);
        const p = data?.[0];
        if (!p) return warn(`У ${stud.name} нет записанных оплат.`);
        const note = p.kind === 'package' ? ' · остаток абонемента не изменится' : '';
        return {
          ok: true,
          a: { type: 'delete_last_payment', student: stud.name, paymentId: p.id },
          line: `🗑 Удалить оплату: ${stud.name} · ${uah(p.amount_uah)} · ${fmtDate(p.pay_date)} · ${AI_KIND[p.kind] ?? p.kind}${note}`,
        };
      }

      case 'reset_package': {
        if (!name) return needName();
        const stud = await findStudent(name);
        if (!stud) return warn(`Не нашла ученика «${name}».`);
        const n = Number(a.lessons) >= 0 ? Math.round(Number(a.lessons)) : 0;
        return {
          ok: true,
          a: { type: 'reset_package', student: stud.name, lessons: n },
          line: `🔄 Абонемент ${stud.name}: было ${stud.package_left || 0} → станет ${n} уроков`,
        };
      }

      default:
        return null; // «none» и всё непонятное — пропускаем
    }
  }

  // Запись в базу (вызывается только после «Верно»). Возвращает строку-результат.
  async function execute(ctx, a) {
    switch (a.type) {
      case 'report': {
        if (a.period === 'today') await report(ctx, today(), today(), 'за сегодня');
        else if (a.period === 'month') await report(ctx, monthStart(), today(), 'за месяц');
        else {
          const w = new Date(); w.setDate(w.getDate() - 6);
          await report(ctx, w.toISOString().slice(0, 10), today(), 'за неделю');
        }
        return null;
      }

      case 'add_lesson': {
        const stud = await ensureStudent(a.student);
        await db.supabase.from('tc_lessons').insert({
          student_id: stud.id, student_name: stud.name,
          lesson_date: a.date, lesson_time: a.time, price_uah: a.price,
          status: a.status, ask_payment: false,
        });
        if (!stud.default_price_uah && a.price > 0) {
          await db.supabase.from('tc_students')
            .update({ default_price_uah: a.price }).eq('id', stud.id);
        }
        const extra = a.status === 'done' ? await consumePackage(stud.id) : '';
        return `✅ Записала урок: ${stud.name} · ${aiWhen(a.date, a.time)} · ${STATUS[a.status]}${extra}`;
      }

      case 'set_status': {
        const { data: les } = await db.supabase
          .from('tc_lessons').select('*').eq('id', a.lessonId).maybeSingle();
        if (!les) return `⚠️ ${a.student}: урок не найден (возможно, уже удалён).`;
        if (les.status === a.status) return `${a.student}: уже отмечено «${STATUS[a.status]}».`;
        await db.supabase.from('tc_lessons').update({ status: a.status }).eq('id', les.id);
        const extra = a.status === 'done' ? await consumePackage(les.student_id) : '';
        return `${STATUS[a.status]}: ${a.student}, ${fmtDate(les.lesson_date)}${extra}`;
      }

      case 'add_payment': {
        const stud = await ensureStudent(a.student);
        const row = {
          student_id: stud.id, student_name: stud.name,
          amount_uah: a.amount, pay_date: today(), kind: a.kind,
        };
        if (a.kind === 'package') row.note = `абонемент ${a.lessons} уроков`;
        await db.supabase.from('tc_payments').insert(row);
        if (a.kind === 'package') {
          const balance = (stud.package_left || 0) + a.lessons;
          await db.supabase.from('tc_students')
            .update({ package_left: balance, package_total: a.lessons }).eq('id', stud.id);
          return `💰 Записала оплату: ${stud.name} · ${uah(a.amount)} · абонемент ${a.lessons} уроков. На балансе: ${balance}.`;
        }
        return `💰 Записала оплату: ${stud.name} · ${uah(a.amount)} · ${AI_KIND[a.kind]}`;
      }

      case 'delete_lesson':
        await db.supabase.from('tc_lessons').delete().eq('id', a.lessonId);
        return `🗑 Удалила урок: ${a.student}`;

      case 'delete_last_payment':
        await db.supabase.from('tc_payments').delete().eq('id', a.paymentId);
        return `🗑 Удалила оплату: ${a.student}`;

      case 'reset_package': {
        const { data: s } = await db.supabase
          .from('tc_students').select('id').ilike('name', a.student).limit(1);
        if (!s?.[0]) return `⚠️ Не нашла ученика ${a.student}.`;
        const patch = { package_left: a.lessons };
        if (a.lessons > 0) patch.package_total = a.lessons;
        await db.supabase.from('tc_students').update(patch).eq('id', s[0].id);
        return `🔄 Абонемент ${a.student}: теперь ${a.lessons} уроков`;
      }

      default:
        return null;
    }
  }

  // Свободный текст владельца → ИИ → «Верно?»
  async function handleAI(ctx, u) {
    await ctx.replyWithChatAction('typing').catch(() => {});
    const list = await students();
    const res = await parseMessage(ctx.message.text, {
      students: list.map((s) => s.name),
      today: today(),
      weekday: new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, weekday: 'long' }).format(new Date()),
    });

    if (res.error === 'no_key') {
      return ctx.reply('🔑 Не нашла ключ Gemini. Проверь переменную GEMINI_API_KEY в Netlify (после добавления нужен новый деплой).');
    }
    if (res.error === 'limit') {
      return ctx.reply('⏳ Лимит бесплатного ИИ сейчас исчерпан. Подожди минуту или пользуйся кнопками: /cab');
    }
    if (res.error) {
      return ctx.reply(`😕 ИИ сейчас не ответил. Попробуй ещё раз или открой /cab\n\n(для отладки: ${res.detail ?? '?'})`);
    }

    const lines = [];
    const ready = [];
    for (const raw of res.actions) {
      const p = await prepare(raw);
      if (!p) continue;
      lines.push(p.line);
      if (p.ok) ready.push(p.a);
    }

    if (!lines.length) {
      return ctx.reply(res.say || 'Не поняла, что записать 🤔 Напиши, например: «Аня сегодня в 15:00 провели».');
    }
    if (!ready.length) {
      return ctx.reply(lines.join('\n') + (res.say ? `\n\n${res.say}` : ''));
    }
    // Только отчёты — ничего не меняют, показываем сразу
    if (ready.every((a) => a.type === 'report')) {
      await db.clearState(u.id);
      for (const a of ready) await execute(ctx, a);
      return;
    }

    await db.setState(u.id, 'tc_ai_confirm', { actions: ready });
    const hasWarn = lines.length > ready.length;
    const kb = new InlineKeyboard().text('✅ Верно', 'tc:ai:ok').text('✖️ Отмена', 'tc:ai:no');
    await ctx.reply(
      `🤖 Я поняла так:\n\n${lines.join('\n')}\n\n` +
      (hasWarn ? '⚠️ — эти пункты я пропущу.\n' : '') +
      (res.say ? `${res.say}\n` : '') +
      'Записать?',
      { reply_markup: kb },
    );
  }

  bot.callbackQuery('tc:ai:ok', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    const actions = u.state === 'tc_ai_confirm' ? u.state_data?.actions : null;
    if (!actions?.length) {
      await ctx.answerCallbackQuery({ text: 'Это уже неактуально' });
      return ctx.editMessageReplyMarkup().catch(() => {});
    }
    await db.clearState(u.id); // сразу, чтобы двойное нажатие не записало дважды
    await ctx.answerCallbackQuery({ text: 'Записываю…' });
    await ctx.editMessageReplyMarkup().catch(() => {});
    // Порядок записи: сначала обнуление и оплаты, потом уроки — чтобы урок
    // списался из только что купленного абонемента. Внутри групп порядок сохраняется.
    const rank = (a) => (a.type === 'reset_package' ? 0 : a.type === 'add_payment' ? 1 : 2);
    const ordered = [...actions].sort((x, y) => rank(x) - rank(y));
    const out = [];
    for (const a of ordered) {
      try {
        const r = await execute(ctx, a);
        if (r) out.push(r);
      } catch (e) {
        console.error('AI execute', a?.type, e);
        out.push(`⚠️ Не получилось: ${a?.type} ${a?.student ?? ''}`);
      }
    }
    if (out.length) {
      await ctx.reply(out.join('\n'), {
        reply_markup: new InlineKeyboard().text('← В кабинет', 'tc:home') });
    }
  });

  bot.callbackQuery('tc:ai:no', async (ctx) => {
    if (!isOwner(ctx)) return ctx.answerCallbackQuery();
    const u = await db.ensureUser(ctx.from);
    if (u.state === 'tc_ai_confirm') await db.clearState(u.id);
    await ctx.answerCallbackQuery({ text: 'Отменила' });
    await ctx.editMessageReplyMarkup().catch(() => {});
    await ctx.reply('Отменила, ничего не записала.');
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

  let txt = planned.length
    ? `🌙 <b>Вечерний итог</b>\n\nОтметь, как прошли уроки, и не забудь записать завтрашние:\n`
    : `🌙 <b>Вечерний итог</b>\n\nНе забудь записать уроки за сегодня (кто был, кто нет) и запланировать завтрашние 📝`;

  const kb = new InlineKeyboard();
  for (const l of planned) {
    txt += `${l.lesson_time || '—'} · ${l.student_name}\n`;
    kb.text(`✅ ${l.student_name}`, `tc:done:${l.id}`).row();
  }
  kb.text('➕ Записать урок', 'tc:new').row();
  kb.text('📅 Сегодня', 'tc:today');

  await bot.api.sendMessage(ENV.OWNER_TG_ID, txt, {
    parse_mode: 'HTML',
    reply_markup: kb,
  }).catch(() => {});
}

// ---------------------------------------------------------------------
// Утреннее напоминание УЧЕНИКАМ (вызывается кроном в 12:00 Киев)
// Шлём каждому привязанному ученику, у кого сегодня запланирован урок.
// ---------------------------------------------------------------------
export async function sendMorningReminders(bot) {
  const d = today();
  const { data: lessons } = await db.supabase
    .from('tc_lessons').select('*')
    .eq('lesson_date', d).eq('status', 'planned');

  if (!lessons?.length) return 0;

  let sent = 0;
  for (const l of lessons) {
    if (!l.student_id) continue;

    // ранние уроки (до 12:00) уже напомнили вчера вечером — пропускаем,
    // чтобы не отправить дважды
    const hour = l.lesson_time ? parseInt(l.lesson_time.slice(0, 2), 10) : null;
    if (hour !== null && hour < 12) continue;

    // берём Telegram ученика
    const { data: stud } = await db.supabase
      .from('tc_students').select('tg_id, name').eq('id', l.student_id).single();
    if (!stud?.tg_id) continue;            // ученик не привязан — пропускаем

    const when = l.lesson_time ? `сегодня в ${l.lesson_time}` : 'сегодня';
    let txt = `👋 Привет! Напоминаю: у тебя урок ${when}.`;

    // реквизиты — только если при записи выбрано «просить оплату»
    if (l.ask_payment) {
      txt += `\n\n${PAY_DETAILS}`;
    }

    const ok = await bot.api.sendMessage(stud.tg_id, txt, { parse_mode: 'HTML' })
      .then(() => true).catch(() => false);
    if (ok) sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------
// Вечернее напоминание УЧЕНИКАМ (вызывается кроном в 22:00 Киев)
// Шлём по ЗАВТРАШНИМ урокам, которые начинаются РАНЬШЕ 12:00 —
// их дневная рассылка (12:00) не успеет напомнить вовремя.
// ---------------------------------------------------------------------
export async function sendTomorrowReminders(bot) {
  const d = tomorrow();
  const { data: lessons } = await db.supabase
    .from('tc_lessons').select('*')
    .eq('lesson_date', d).eq('status', 'planned');

  if (!lessons?.length) return 0;

  let sent = 0;
  for (const l of lessons) {
    if (!l.student_id) continue;

    // только ранние уроки: время есть и оно строго раньше 12:00
    const hour = l.lesson_time ? parseInt(l.lesson_time.slice(0, 2), 10) : null;
    if (hour === null || hour >= 12) continue;

    const { data: stud } = await db.supabase
      .from('tc_students').select('tg_id, name').eq('id', l.student_id).single();
    if (!stud?.tg_id) continue;

    let txt = `👋 Привет! Напоминаю: завтра у тебя урок в ${l.lesson_time}.`;
    if (l.ask_payment) txt += `\n\n${PAY_DETAILS}`;

    const ok = await bot.api.sendMessage(stud.tg_id, txt, { parse_mode: 'HTML' })
      .then(() => true).catch(() => false);
    if (ok) sent++;
  }
  return sent;
}
