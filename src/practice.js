import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { screen, kbBackMain, escapeHtml } from './ui.js';

const TZ = 'Europe/Kyiv';
export const LEVELS = ['A0', 'A1', 'A2', 'B1', 'B2'];

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function kyivHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false,
  }).format(new Date()));
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// ---------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------
async function getSub(userId) {
  const { data } = await db.supabase
    .from('practice_subs').select('*').eq('user_id', userId).maybeSingle();
  return data;
}

async function answeredIds(userId) {
  const { data } = await db.supabase
    .from('practice_answers').select('task_id').eq('user_id', userId);
  return (data ?? []).map((r) => r.task_id);
}

// Следующее задание: по порядку тем, внутри темы — по возрастанию сложности
async function pickTask(userId, level) {
  const seen = await answeredIds(userId);

  let q = db.supabase
    .from('practice_queue')
    .select('*')
    .eq('level', level)
    .order('topic_order', { ascending: true })
    .order('step', { ascending: true })
    .limit(1);

  if (seen.length) q = q.not('id', 'in', `(${seen.join(',')})`);

  const { data } = await q;
  return data?.[0] ?? null;
}

// Сколько заданий решено сегодня
async function solvedToday(userId) {
  const from = `${kyivToday()}T00:00:00Z`;
  const { count } = await db.supabase
    .from('practice_answers')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('answered_at', from);
  return count ?? 0;
}

// Прогресс по уровню
async function levelProgress(userId, level) {
  const seen = await answeredIds(userId);
  const { count: total } = await db.supabase
    .from('practice_queue')
    .select('id', { count: 'exact', head: true })
    .eq('level', level);

  let doneQ = db.supabase
    .from('practice_queue')
    .select('id', { count: 'exact', head: true })
    .eq('level', level);
  if (seen.length) doneQ = doneQ.in('id', seen);
  const { count: done } = seen.length ? await doneQ : { count: 0 };

  return { total: total ?? 0, done: done ?? 0 };
}

// ---------------------------------------------------------------------
// Отправка задания
// ---------------------------------------------------------------------
// Ссылка на диалог «поделиться» в Telegram
function shareButton(ctx) {
  const username = ctx.me?.username;
  if (!username) return null;
  const link = `https://t.me/${username}?start=share`;
  const text = 'Бесплатный тренажёр по немецкому: одно задание в день с разбором';
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

function taskKeyboard(task) {
  const kb = new InlineKeyboard();
  task.options.forEach((opt, i) => kb.text(opt, `pq:${task.id}:${i}`).row());
  return kb;
}

function taskText(task) {
  return (
    `🎯 <b>${escapeHtml(task.topic_title)}</b> · задание ${task.step} из 10\n\n` +
    task.question
  );
}

export async function sendTask(bot, tgId, task) {
  await bot.api.sendMessage(tgId, taskText(task), {
    parse_mode: 'HTML', reply_markup: taskKeyboard(task),
  });
}

// ---------------------------------------------------------------------
// Ежедневная рассылка
// ---------------------------------------------------------------------
export async function runDailyPractice(bot) {
  const settings = await db.getSettings(true);
  if (settings.practice_enabled === 'false') return 0;

  const hour  = kyivHour();
  const today = kyivToday();

  const { data: subs } = await db.supabase
    .from('practice_subs')
    .select('*, users(tg_id)')
    .eq('is_active', true)
    .eq('send_hour', hour);

  let sent = 0;

  for (const sub of subs ?? []) {
    if (sub.last_sent_at && sub.last_sent_at.slice(0, 10) >= today) continue;

    const task = await pickTask(sub.user_id, sub.level);

    if (!task) {
      await bot.api.sendMessage(
        sub.users.tg_id,
        `Ты прошла все задания уровня ${sub.level} 👏\n\n` +
        'Можно переключиться на следующий уровень в разделе «Задание дня».',
      ).catch(() => {});
    } else {
      await sendTask(bot, sub.users.tg_id, task).then(() => sent++).catch(() => {});
    }

    await db.supabase.from('practice_subs')
      .update({ last_sent_at: new Date().toISOString() })
      .eq('user_id', sub.user_id);
  }

  return sent;
}

// ---------------------------------------------------------------------
// Возврат пропавших: одно сообщение с готовым заданием
// ---------------------------------------------------------------------
export async function runWinback(bot) {
  const settings = await db.getSettings();
  const gap   = Number(settings.winback_days || 3);
  const today = kyivToday();

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - gap);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const { data: subs } = await db.supabase
    .from('practice_subs')
    .select('*, users(tg_id)')
    .eq('is_active', true)
    .lte('last_answer_on', cutoffStr);

  let sent = 0;

  for (const sub of subs ?? []) {
    // не чаще раза в неделю
    if (sub.last_winback_on && daysBetween(sub.last_winback_on, today) < 7) continue;

    const task = await pickTask(sub.user_id, sub.level);
    if (!task) continue;

    await bot.api.sendMessage(
      sub.users.tg_id,
      'Пара дней тишины — бывает 🙂 Вот задание, чтобы вернуться без разгона:',
    ).then(() => sendTask(bot, sub.users.tg_id, task))
     .then(async () => {
       sent++;
       await db.supabase.from('practice_subs')
         .update({ last_winback_on: today }).eq('user_id', sub.user_id);
     })
     .catch(() => {});
  }

  return sent;
}

// ---------------------------------------------------------------------
// Экран раздела
// ---------------------------------------------------------------------
async function showPractice(ctx) {
  const user = await db.ensureUser(ctx.from);
  const sub  = await getSub(user.id);
  const kb   = new InlineKeyboard();

  if (!sub || !sub.is_active) {
    kb.text('Начать заниматься', 'pon').row();
    kb.text('← В главное меню', 'menu:main');
    return screen(
      ctx,
      '🎯 <b>Задание дня</b>\n\n' +
      'Задания разбиты по темам: в каждой теме десять шагов, ' +
      'и каждый следующий чуть сложнее предыдущего.\n\n' +
      'После ответа я объясняю <b>почему</b> так — понимание правила ' +
      'работает лучше, чем зубрёжка исключений.\n\n' +
      'Несколько заданий в день, бесплатно, ' +
      'отписаться можно в любой момент.',
      kb,
    );
  }

  const { total, done } = await levelProgress(user.id, sub.level);
  const todayCount = await solvedToday(user.id);
  const accuracy = sub.answered_count
    ? Math.round((sub.correct_count / sub.answered_count) * 100) : 0;

  kb.text('Заниматься сейчас', 'pmore').row();
  const share = shareButton(ctx);
  if (share) kb.url('Поделиться с другом', share).row();
  kb.text(`📐 Уровень: ${sub.level}`, 'plevel')
    .text(`🔢 В день: ${sub.daily_count}`, 'pcount').row();
  kb.text(`⏰ Время: ${String(sub.send_hour).padStart(2, '0')}:00`, 'ptime').row();
  kb.text('Выключить', 'poff').row();
  kb.text('← В главное меню', 'menu:main');

  await screen(
    ctx,
    '🎯 <b>Задание дня</b>\n\n' +
    `Уровень: <b>${sub.level}</b> · пройдено ${done} из ${total}\n` +
    `Серия: <b>${sub.streak}</b> дн. подряд (лучшая — ${sub.best_streak})\n` +
    `Сегодня решено: ${todayCount} из ${sub.daily_count}\n` +
    (sub.answered_count ? `Правильных ответов: ${accuracy}%\n` : '') +
    `\nЗадания приходят в ${String(sub.send_hour).padStart(2, '0')}:00.`,
    kb,
  );
}

// Показываем предложение минибука периодически, а не единожды
async function maybeSuggestMinibook(ctx, user, sub) {
  // уже покупал — не предлагаем
  const { data: bought } = await db.supabase
    .from('orders')
    .select('id')
    .eq('user_id', user.id)
    .eq('product_type', 'digital')
    .eq('status', 'paid')
    .limit(1);
  if (bought?.length) return;

  // не чаще раза в 7 дней
  const today = kyivToday();
  if (sub.last_suggest_on && daysBetween(sub.last_suggest_on, today) < 7) return;

  await db.supabase.from('practice_subs')
    .update({ last_suggest_on: today }).eq('user_id', user.id);

  await ctx.reply(
    'Кстати 🙂 Тебе явно заходит формат — если хочется системнее, ' +
    'в минибуке такие же разборы на 70+ страниц и таблицы, к которым удобно возвращаться.',
    { reply_markup: new InlineKeyboard().text('Посмотреть минибук', 'menu:materials') },
  );
}

// ---------------------------------------------------------------------
export function registerPractice(bot) {
  bot.callbackQuery('menu:practice', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPractice(ctx);
  });
  bot.command('practice', (ctx) => showPractice(ctx));

  // --- Включение -------------------------------------------------------
  bot.callbackQuery('pon', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.ensureUser(ctx.from);
    const settings = await db.getSettings();

    await db.supabase.from('practice_subs').upsert({
      user_id: user.id,
      is_active: true,
      send_hour: Number(settings.practice_default_hour || 10),
    }, { onConflict: 'user_id' });

    const kb = new InlineKeyboard();
    LEVELS.forEach((l, i) => {
      kb.text(l, `psetlevel:${l}`);
      if (i === 2) kb.row();
    });
    await ctx.reply(
      'С какого уровня начнём?\n\n' +
      '<b>A0</b> — с нуля, читаю с трудом\n' +
      '<b>A1</b> — знаю базу, говорю простыми фразами\n' +
      '<b>A2</b> — понимаю речь, путаюсь в грамматике\n' +
      '<b>B1</b> — говорю, но хочу точности\n' +
      '<b>B2</b> — свободно, шлифую нюансы',
      { parse_mode: 'HTML', reply_markup: kb },
    );
  });

  bot.callbackQuery('poff', async (ctx) => {
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('practice_subs')
      .update({ is_active: false }).eq('user_id', user.id);
    await ctx.answerCallbackQuery({ text: 'Выключено' });
    await ctx.reply('Выключила. Прогресс и серия сохранятся.', { reply_markup: kbBackMain() });
  });

  // --- Уровень ---------------------------------------------------------
  bot.callbackQuery('plevel', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    LEVELS.forEach((l, i) => {
      kb.text(l, `psetlevel:${l}`);
      if (i === 2) kb.row();
    });
    await ctx.reply('Выбери уровень:', { reply_markup: kb });
  });

  bot.callbackQuery(/^psetlevel:(\w+)$/, async (ctx) => {
    const level = ctx.match[1];
    const user  = await db.ensureUser(ctx.from);
    await db.supabase.from('practice_subs')
      .update({ level }).eq('user_id', user.id);
    await ctx.answerCallbackQuery({ text: `Уровень ${level}` });

    const task = await pickTask(user.id, level);
    if (!task) {
      return ctx.reply(
        `На уровне ${level} заданий пока нет — скоро добавлю.`,
        { reply_markup: kbBackMain() },
      );
    }
    await ctx.reply('Поехали 👇');
    await sendTask(bot, ctx.from.id, task);
  });

  // --- Сколько в день ---------------------------------------------------
  bot.callbackQuery('pcount', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    [1, 3, 5, 10].forEach((n) => kb.text(String(n), `psetcount:${n}`));
    await ctx.reply('Сколько заданий в день?', { reply_markup: kb });
  });

  bot.callbackQuery(/^psetcount:(\d+)$/, async (ctx) => {
    const n = Number(ctx.match[1]);
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('practice_subs')
      .update({ daily_count: n }).eq('user_id', user.id);
    await ctx.answerCallbackQuery({ text: 'Сохранено' });
    await ctx.reply(`Теперь ${n} заданий в день.`);
  });

  // --- Время ------------------------------------------------------------
  bot.callbackQuery('ptime', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    [8, 10, 12, 15, 18, 20].forEach((h, i) => {
      kb.text(`${String(h).padStart(2, '0')}:00`, `psethour:${h}`);
      if (i % 3 === 2) kb.row();
    });
    await ctx.reply('Во сколько присылать?', { reply_markup: kb });
  });

  bot.callbackQuery(/^psethour:(\d+)$/, async (ctx) => {
    const hour = Number(ctx.match[1]);
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('practice_subs')
      .update({ send_hour: hour }).eq('user_id', user.id);
    await ctx.answerCallbackQuery({ text: 'Сохранено' });
    await ctx.reply(`Буду присылать в ${String(hour).padStart(2, '0')}:00.`);
  });

  // --- Следующее задание -------------------------------------------------
  bot.callbackQuery('pmore', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.ensureUser(ctx.from);
    const sub  = await getSub(user.id);
    const task = await pickTask(user.id, sub?.level ?? 'A0');

    if (!task) {
      const kb = new InlineKeyboard().text('Сменить уровень', 'plevel').row()
        .text('← В главное меню', 'menu:main');
      return ctx.reply(
        `Задания уровня ${sub?.level ?? 'A0'} закончились 👏 ` +
        'Можно перейти на следующий уровень.',
        { reply_markup: kb },
      );
    }
    await sendTask(bot, ctx.from.id, task);
  });

  // --- Ответ -------------------------------------------------------------
  bot.callbackQuery(/^pq:([^:]+):(\d+)$/, async (ctx) => {
    const [, taskId, pickedStr] = ctx.match;
    const picked = Number(pickedStr);
    const user = await db.ensureUser(ctx.from);

    const { data: task } = await db.supabase
      .from('practice_queue').select('*').eq('id', taskId).maybeSingle();
    if (!task) return ctx.answerCallbackQuery();

    const correct = picked === task.correct_ix;
    await ctx.answerCallbackQuery({ text: correct ? 'Верно!' : 'Не совсем' });

    const { error } = await db.supabase.from('practice_answers')
      .insert({ user_id: user.id, task_id: task.id, is_correct: correct });
    const firstTime = !error;

    let sub = await getSub(user.id);
    if (sub && firstTime) {
      const today = kyivToday();
      let streak = sub.streak;
      if (!sub.last_answer_on) streak = 1;
      else {
        const gap = daysBetween(sub.last_answer_on, today);
        if (gap === 1) streak = sub.streak + 1;
        else if (gap > 1) streak = 1;
      }
      await db.supabase.from('practice_subs').update({
        streak,
        best_streak:    Math.max(streak, sub.best_streak),
        answered_count: sub.answered_count + 1,
        correct_count:  sub.correct_count + (correct ? 1 : 0),
        last_answer_on: today,
      }).eq('user_id', user.id);
      sub = { ...sub, streak };
    }

    const right = task.options[task.correct_ix];
    const head  = correct ? '✅ <b>Верно!</b>'
                          : `❌ <b>Правильно: ${escapeHtml(right)}</b>`;

    const done = await solvedToday(user.id);
    const goal = sub?.daily_count ?? 3;
    const finished = done >= goal;

    const kb = new InlineKeyboard();
    if (finished) {
      kb.text('Хочу ещё', 'pmore').row();
      const share = shareButton(ctx);
      if (share) kb.url('Поделиться с другом', share).row();
    } else {
      kb.text(`Следующее (${done} из ${goal})`, 'pmore').row();
    }
    kb.text('☰ Главное меню', 'menu:main');

    let tail = '';
    if (finished && sub?.streak > 1) {
      tail = `\n\n🔥 Норма на сегодня выполнена. Серия: ${sub.streak} дн. подряд`;
    } else if (finished) {
      tail = '\n\n👏 Норма на сегодня выполнена';
    }

    await ctx.editMessageText(
      `${taskText(task)}\n\n${head}\n\n${task.explanation}${tail}`,
      { parse_mode: 'HTML', reply_markup: kb },
    ).catch(() => {});

    // Мягкое предложение минибука: не чаще раза в 7 дней и только тем,
    // кто ещё не покупал. Первый раз — после 5-го задания.
    if (firstTime && sub && (sub.answered_count + 1) >= 5) {
      await maybeSuggestMinibook(ctx, user, sub);
    }
  });
}
