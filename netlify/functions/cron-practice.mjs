// Ежечасная задача: рассылка «задания дня» тем, у кого настал их час.
import { getBot } from '../../src/bot.js';
import { runDailyPractice } from '../../src/practice.js';
import { postDailyQuiz } from '../../src/channel.js';

export default async () => {
  const bot = getBot();
  await bot.init();
  try {
    const sent   = await runDailyPractice(bot);
    const posted = await postDailyQuiz(bot);
    console.log(`practice sent:${sent} channel posted:${posted}`);
    return new Response(`ok: ${sent}`, { status: 200 });
  } catch (e) {
    console.error('PRACTICE CRON ERROR', e);
    return new Response('error', { status: 200 });
  }
};

export const config = { schedule: '5 * * * *' };
