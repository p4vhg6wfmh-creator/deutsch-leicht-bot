import { InlineKeyboard } from 'grammy';
import * as db from './db.js';
import { screen, kbBackMain, escapeHtml } from './ui.js';

const TZ = 'Europe/Kyiv';

function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}

function kyivHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false,
  }).format(new Date()));
}

function daysBetween(fromStr, toStr) {
  return Math.round((new Date(toStr) - new Date(fromStr)) / 86400000);
}

// ---------------------------------------------------------------------
// Данные
// ---------------------------------------------------------------------
async function getSub(userId) {
  const { data } = await db.supabase
    .from('practice_subs').select('*').eq('user_id', userId).maybeSingle();
  return data;
}

async function pickTask(userId, level) {
  const { data: done } = await db.supabase
    .from('practice_answers').select('task_id').eq('user_id', userId);
  const seen = (done ?? []).map((r) => r.task_id);

  let q = db.supabase
    .from('practice_tasks')
    .select('*')
    .eq('is_active', true)
    .eq('level', level)
    .order('sort_order', { ascending: true })
    .limit(1);

  if (seen.length) q = q.not('id', 'in', `(${seen.join(',')})`);

  const { data } = await q;
  return data?.[0] ?? null;
}

function taskKeyboard(task) {
  const kb = new InlineKeyboard();
  task.options.forEach((opt, i) => {
    kb.text(opt, `pq:${task.id}:${i}`).row();
  });
  return kb;
}

export async function sendTask(bot, tgId, task) {
  await bot.api.sendMessage(
    tgId,
    `🎯 <b>Задание дня</b>\n\n${task.question}`,
    { parse_mode: 'HTML', reply_markup: taskKeyboard(task) },
  );
}

// ---------------------------------------------------------------------
// Ежедневная рассылка (вызывается по расписанию, раз в час)
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
    // уже отправляли сегодня
    if (sub.last_sent_at && sub.last_sent_at.slice(0, 10) >= today) continue;

    const task = await pickTask(sub.user_id, sub.level);

    if (!task) {
      await bot.api.sendMessage(
        sub.users.tg_id,
        'Ты прошла все задания этого уровня 👏 Новые добавляю регулярно — ' +
        'загляни через пару дней.',
      ).catch(() => {});
      await db.supabase.from('practice_subs')
        .update({ last_sent_at: new Date().toISOString() })
        .eq('user_id', sub.user_id);
      continue;
    }

    await sendTask(bot, sub.users.tg_id, task)
      .then(async () => {
        sent++;
        await db.supabase.from('practice_subs')
          .update({ last_sent_at: new Date().toISOString() })
          .eq('user_id', sub.user_id);
      })
      .catch(() => {});
  }

  return sent;
}

// ---------------------------------------------------------------------
// Экраны
// ---------------------------------------------------------------------
async function showPractice(ctx) {
  const user = await db.ensureUser(ctx.from);
  const sub  = await getSub(user.id);

  const kb = new InlineKeyboard();

  if (!sub || !sub.is_active) {
    kb.text('Включить задание дня', 'pon').row();
    kb.text('← В главное меню', 'menu:main');
    return screen(
      ctx,
      '🎯 <b>Задание дня</b>\n\n' +
      'Одно короткое задание каждый день — минута времени, ' +
      'но именно так язык остаётся в голове.\n\n' +
      'После ответа я объясняю <b>почему</b> так, а не просто ставлю галочку. ' +
      'Понимание правила работает лучше, чем зубрёжка исключений.\n\n' +
      'Бесплатно, отписаться можно в любой момент.',
      kb,
    );
  }

  const accuracy = sub.answered_count
    ? Math.round((sub.correct_count / sub.answered_count) * 100)
    : 0;

  kb.text('Задание сейчас', 'pmore').row();
  kb.text(`⏰ Время: ${String(sub.send_hour).padStart(2, '0')}:00`, 'ptime').row();
  kb.text('Выключить', 'poff').row();
  kb.text('← В главное меню', 'menu:main');

  await screen(
    ctx,
    '🎯 <b>Задание дня</b>\n\n' +
    `Серия: <b>${sub.streak}</b> дн. подряд\n` +
    `Лучшая серия: ${sub.best_streak} дн.\n` +
    `Решено заданий: ${sub.answered_count}\n` +
    (sub.answered_count ? `Правильных: ${accuracy}%\n` : '') +
    `\nПриходит каждый день в ${String(sub.send_hour).padStart(2, '0')}:00.`,
    kb,
  );
}

// ---------------------------------------------------------------------
export function registerPractice(bot) {
  bot.callbackQuery('menu:practice', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPractice(ctx);
  });

  bot.command('practice', (ctx) => showPractice(ctx));

  // --- Подписка -------------------------------------------------------
  bot.callbackQuery('pon', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.ensureUser(ctx.from);
    const settings = await db.getSettings();

    await db.supabase.from('practice_subs').upsert({
      user_id:   user.id,
      is_active: true,
      send_hour: Number(settings.practice_default_hour || 10),
    }, { onConflict: 'user_id' });

    await ctx.reply(
      'Готово! Первое задание пришлю завтра утром.\n\n' +
      'А вот одно прямо сейчас, чтобы не ждать 👇',
    );

    const sub  = await getSub(user.id);
    const task = await pickTask(user.id, sub.level);
    if (task) await sendTask(bot, ctx.from.id, task);
  });

  bot.callbackQuery('poff', async (ctx) => {
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('practice_subs')
      .update({ is_active: false }).eq('user_id', user.id);
    await ctx.answerCallbackQuery({ text: 'Выключено' });
    await ctx.reply(
      'Выключила. Включить обратно можно в любой момент — серия сохранится.',
      { reply_markup: kbBackMain() },
    );
  });

  // --- Выбор времени ---------------------------------------------------
  bot.callbackQuery('ptime', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    [8, 10, 12, 15, 18, 20].forEach((h, i) => {
      kb.text(`${String(h).padStart(2, '0')}:00`, `psethour:${h}`);
      if (i % 3 === 2) kb.row();
    });
    await ctx.reply('Во сколько присылать задание?', { reply_markup: kb });
  });

  bot.callbackQuery(/^psethour:(\d+)$/, async (ctx) => {
    const hour = Number(ctx.match[1]);
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('practice_subs')
      .update({ send_hour: hour }).eq('user_id', user.id);
    await ctx.answerCallbackQuery({ text: 'Сохранено' });
    await ctx.reply(`Теперь задание будет приходить в ${String(hour).padStart(2, '0')}:00.`);
  });

  // --- Ещё одно задание -----------------------------------------------
  bot.callbackQuery('pmore', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.ensureUser(ctx.from);
    const sub  = await getSub(user.id);
    const task = await pickTask(user.id, sub?.level ?? 'A0');

    if (!task) {
      return ctx.reply(
        'Задания этого уровня закончились 👏 Новые добавляю регулярно.',
        { reply_markup: kbBackMain() },
      );
    }
    await sendTask(bot, ctx.from.id, task);
  });

  // --- Ответ на задание -------------------------------------------------
  bot.callbackQuery(/^pq:([^:]+):(\d+)$/, async (ctx) => {
    const [, taskId, pickedStr] = ctx.match;
    const picked = Number(pickedStr);
    const user = await db.ensureUser(ctx.from);

    const { data: task } = await db.supabase
      .from('practice_tasks').select('*').eq('id', taskId).maybeSingle();
    if (!task) return ctx.answerCallbackQuery();

    const correct = picked === task.correct_ix;
    await ctx.answerCallbackQuery({ text: correct ? 'Верно!' : 'Не совсем' });

    // Записываем ответ (повторный не перезаписываем)
    const { error } = await db.supabase.from('practice_answers')
      .insert({ user_id: user.id, task_id: task.id, is_correct: correct });

    const firstTime = !error;

    // Обновляем серию
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

    // Показываем правильный ответ и разбор
    const right = task.options[task.correct_ix];
    const head = correct
      ? '✅ <b>Верно!</b>'
      : `❌ <b>Правильно: ${escapeHtml(right)}</b>`;

    const streakLine = sub && firstTime && sub.streak > 1
      ? `\n\n🔥 Серия: ${sub.streak} дн. подряд`
      : '';

    const kb = new InlineKeyboard()
      .text('Ещё задание', 'pmore').row()
      .text('☰ Главное меню', 'menu:main');

    await ctx.editMessageText(
      `${task.question}\n\n${head}\n\n${task.explanation}${streakLine}`,
      { parse_mode: 'HTML', reply_markup: kb },
    ).catch(() => {});

    // Мягкое предложение минибука после пятого задания
    if (firstTime && sub && (sub.answered_count + 1) === 5) {
      await ctx.reply(
        'Кстати, ты решила уже пять заданий подряд 👏\n\n' +
        'Если хочется системнее — в минибуке таких разборов больше семидесяти страниц, ' +
        'и там же таблицы, к которым удобно возвращаться.',
        { reply_markup: new InlineKeyboard().text('Посмотреть минибук', 'menu:materials') },
      );
    }
  });
}
