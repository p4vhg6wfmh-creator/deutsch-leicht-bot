// Ежечасная задача: брони, напоминания об уроках, продления, возврат пропавших.
import { getBot } from '../../src/bot.js';
import { runRenewalReminders } from '../../src/groups.js';
import { releaseExpiredHolds, sendLessonReminders } from '../../src/lessons.js';
import { runWinback } from '../../src/practice.js';
import { sendEveningReminder } from '../../src/teacher.js';

const TZ = 'Europe/Kyiv';
const kyivHour = () => Number(new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', hour12: false,
}).format(new Date()));

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

    // ВРЕМЕННО ДЛЯ ТЕСТА — шлём всегда, потом вернуть «if (h === 18)»
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
