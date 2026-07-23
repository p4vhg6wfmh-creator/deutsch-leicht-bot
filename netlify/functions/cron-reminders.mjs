// Ежедневная задача: напоминания о продлении оплаты в группах.
// Расписание задаётся ниже в config.schedule (UTC, формат cron).
import { getBot } from '../../src/bot.js';
import { runRenewalReminders } from '../../src/groups.js';

export default async () => {
  const bot = getBot();
  await bot.init();

  try {
    const sent = await runRenewalReminders(bot);
    console.log(`renewal reminders sent: ${sent}`);
    return new Response(`ok: ${sent}`, { status: 200 });
  } catch (e) {
    console.error('CRON ERROR', e);
    return new Response('error', { status: 200 });
  }
};

// 07:00 UTC = 10:00 по Киеву
export const config = { schedule: '0 7 * * *' };
