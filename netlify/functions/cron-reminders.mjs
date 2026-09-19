// Крон: утреннее напоминание ученикам (12:00 Киев), winback (10:00 Киев)
// и вечернее напоминание владельцу + завтрашним ранним урокам (22:00 Киев).
import { getBot } from '../../src/bot.js';
import { runWinback } from '../../src/practice.js';
import { sendEveningReminder, sendMorningReminders, sendTomorrowReminders } from '../../src/teacher.js';

export default async () => {
  const bot = getBot();
  await bot.init();
  try {
    let winback = 0, evening = 0, morning = 0, tomorrow = 0;
    const h = new Date().getUTCHours();

    if (h === 7) {                    // 10:00 по Киеву — возврат забросивших
      winback = await runWinback(bot);
    }

    if (h === 9) {                    // 12:00 по Киеву — напоминание по сегодняшним урокам (после 12:00)
      morning = await sendMorningReminders(bot);
    }

    if (h === 19) {                   // 22:00 по Киеву — завтрашние ранние уроки (до 12:00) + вечерний итог владельцу
      tomorrow = await sendTomorrowReminders(bot);
      evening = await sendEveningReminder(bot);
    }

    console.log(`winback:${winback} morning:${morning} tomorrow:${tomorrow} evening:${evening}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('CRON ERROR', e);
    return new Response('error', { status: 200 });
  }
};

export const config = { schedule: '15 7,9,19 * * *' };
