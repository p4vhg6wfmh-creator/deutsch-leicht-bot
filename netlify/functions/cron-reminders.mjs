// Ежечасная задача: брони, напоминания об уроках, продления, возврат пропавших.
import { getBot } from '../../src/bot.js';
import { runRenewalReminders } from '../../src/groups.js';
import { releaseExpiredHolds, sendLessonReminders } from '../../src/lessons.js';
import { runWinback } from '../../src/practice.js';

const TZ = 'Europe/Kyiv';
const kyivHour = () => Number(new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', hour12: false,
}).format(new Date()));

export default async () => {
  const bot = getBot();
  await bot.init();

  try {
    const released = await releaseExpiredHolds();
    const lessons  = await sendLessonReminders(bot);

    let renewals = 0, winback = 0;
    if (kyivHour() === 10) {          // раз в сутки
      renewals = await runRenewalReminders(bot);
      winback  = await runWinback(bot);
    }

    console.log(`holds:${released} lessons:${lessons} renewals:${renewals} winback:${winback}`);
    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('CRON ERROR', e);
    return new Response('error', { status: 200 });
  }
};

export const config = { schedule: '15 * * * *' };
