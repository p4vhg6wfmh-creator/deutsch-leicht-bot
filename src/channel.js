import * as db from './db.js';

const TZ = 'Europe/Kyiv';

const kyivHour = () => Number(new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', hour12: false,
}).format(new Date()));

const kyivToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ })
  .format(new Date());

// Telegram разрешает не больше 200 символов в пояснении к викторине
function shortExplanation(html) {
  const plain = html.replace(/<[^>]+>/g, '');
  if (plain.length <= 200) return plain;
  const cut = plain.slice(0, 200);
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return dot > 80 ? cut.slice(0, dot + 1) : cut.slice(0, 197) + '…';
}

// ---------------------------------------------------------------------
// Подписан ли человек на канал
// ---------------------------------------------------------------------
export async function isSubscribed(bot, tgId) {
  const settings = await db.getSettings();
  const channel = settings.channel_id;
  if (!channel) return true;               // канал не настроен — не мешаем

  try {
    const m = await bot.api.getChatMember(channel, tgId);
    return ['creator', 'administrator', 'member'].includes(m.status);
  } catch {
    return true;                           // не смогли проверить — не мешаем
  }
}

// ---------------------------------------------------------------------
// Ежедневная публикация викторины в канал
// ---------------------------------------------------------------------
export async function postDailyQuiz(bot) {
  const settings = await db.getSettings(true);
  if (settings.channel_enabled !== 'true') return 0;

  const channel = settings.channel_id;
  if (!channel) return 0;
  if (kyivHour() !== Number(settings.channel_post_hour || 11)) return 0;

  const today = kyivToday();

  // уже публиковали сегодня
  const { count: postedToday } = await db.supabase
    .from('practice_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('posted_on', today);
  if (postedToday) return 0;

  // берём ещё не публиковавшееся, начиная с простого
  const { data } = await db.supabase
    .from('practice_queue')
    .select('*')
    .is('posted_on', null)
    .order('topic_order', { ascending: true })
    .order('step', { ascending: true })
    .limit(1);

  const task = data?.[0];
  if (!task) return 0;

  const options = task.options.map((o) => String(o).slice(0, 100));

  await bot.api.sendPoll(
    channel,
    `${task.topic_title} · ${task.level}\n\n${task.question.replace(/<[^>]+>/g, '')}`,
    options,
    {
      type: 'quiz',
      correct_option_id: task.correct_ix,
      explanation: shortExplanation(task.explanation),
      is_anonymous: true,
    },
  );

  await db.supabase.from('practice_tasks')
    .update({ posted_on: today }).eq('id', task.id);

  // каждый N-й пост — со ссылкой на бота
  const every = Number(settings.channel_cta_every || 4);
  const { count: postedTotal } = await db.supabase
    .from('practice_tasks')
    .select('id', { count: 'exact', head: true })
    .not('posted_on', 'is', null);

  if (every > 0 && postedTotal % every === 0) {
    const me = await bot.api.getMe();
    await bot.api.sendMessage(
      channel,
      'Хочешь такие задания каждый день и с полным разбором — ' +
      `они в боте: t.me/${me.username}?start=channel\n\n` +
      'Там же можно выбрать уровень от A0 до B2 и заниматься по темам.',
      { link_preview_options: { is_disabled: true } },
    ).catch(() => {});
  }

  return 1;
}
