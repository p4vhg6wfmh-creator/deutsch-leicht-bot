// Крон: продления (10:00 Киев) и вечернее напоминание (21:00 Киев).
import { getBot } from '../../src/bot.js';
import { runRenewalReminders } from '../../src/groups.js';
import { runWinback } from '../../src/practice.js';
import { sendEveningReminder } from '../../src/teacher.js';

export default async () => {
  const bot = getBot();
  await bot.init();
  try {
    let renewals = 0, winback = 0, evening = 0;
    const h = new Date().getUTCHours();

    if (h === 7) {                    // 10:00 по Киеву — продления
      renewals = await runRenewalReminders(bot);
      winback  = await runWinback(bot);
    }

    if (h === 18) {                   // 21:00 по Киеву — вечернее напоминание
      evening = await sendEveningReminder(bot);
    }

    console.log(`renewals:${renewals} winback:${winback} evening:${evening}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('CRON ERROR', e);
    return new Response('error', { status: 200 });
  }
};

export const config = { schedule: '15 7,18 * * *' };
