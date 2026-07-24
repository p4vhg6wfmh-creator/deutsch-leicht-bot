import * as db from './db.js';
import {
  T, kbEntry, kbMain, kbProduct, kbBackMain, kbPersistent, screen,
  money, escapeHtml,
} from './ui.js';
import { memberships } from './groups.js';
import { isSubscribed } from './channel.js';

const SECTION_TITLES = {
  lessons:   '📚 <b>Занятия с преподавателем</b>',
  materials: '🎧 <b>Материалы и курсы</b>',
  club:      '🔑 <b>Клуб Deutsch bewusst</b>',
};

// Куда вести человека после ответа на входной вопрос
const ENTRY_SECTION = {
  zero:     'lessons',
  speaking: 'lessons',
  self:     'materials',
  browsing: 'main',
};

async function mainMenuKeyboard() {
  const club = await db.countActive('club');
  return kbMain({ hasClub: club > 0 });
}

export async function showMain(ctx) {
  const kb = await mainMenuKeyboard();
  await screen(ctx, T.mainMenu, kb);
}

export async function showSection(ctx, section, prefix = '') {
  const products = await db.listProducts(section);

  if (!products.length) {
    await screen(ctx, T.emptySection, kbBackMain());
    return;
  }

  // Один продукт в разделе — показываем карточку сразу,
  // и «назад» ведёт в главное меню, а не обратно в этот же раздел
  if (products.length === 1) {
    await showProduct(ctx, products[0], prefix, 'menu:main');
    return;
  }

  const { InlineKeyboard } = await import('grammy');
  const kb = new InlineKeyboard();
  for (const p of products) {
    kb.text(`${p.title} · ${money(p.price_eur)}`, `card:${p.id}`).row();
  }
  kb.text('← В главное меню', 'menu:main');

  const text = `${prefix}${prefix ? '\n\n' : ''}${SECTION_TITLES[section]}`;
  await screen(ctx, text, kb);
}

export async function showProduct(ctx, product, prefix = '', backTo = 'menu:main') {
  const text =
    `${prefix}${prefix ? '\n\n' : ''}` +
    `<b>${escapeHtml(product.title)}</b>\n\n` +
    `${product.description ?? ''}\n\n` +
    `Стоимость: <b>${money(product.price_eur)}</b>`;

  await screen(ctx, text, kbProduct(product, backTo));
}

// ---------------------------------------------------------------------
export function registerMenu(bot) {
  bot.command('start', async (ctx) => {
    const payload = ctx.match?.trim() || null;
    const user = await db.ensureUser(ctx.from, payload);
    await db.clearState(user.id);

    await ctx.reply('Открываю меню 👇', { reply_markup: kbPersistent() });

    // Мягкое приглашение в канал — ничего не блокирует
    const settings = await db.getSettings();
    if (settings.channel_url) {
      const subscribed = await isSubscribed({ api: ctx.api }, ctx.from.id);
      if (!subscribed) {
        const { InlineKeyboard } = await import('grammy');
        await ctx.reply(
          'Кстати, я веду канал — там разборы, задания и новости про группы.',
          { reply_markup: new InlineKeyboard().url('Подписаться', settings.channel_url) },
        ).catch(() => {});
      }
    }

    // Уже отвечал на входной вопрос — сразу в меню
    if (user.entry_answer) return showMain(ctx);

    await ctx.reply(T.welcome, { reply_markup: kbEntry(), parse_mode: 'HTML' });
  });

  bot.command('menu', (ctx) => showMain(ctx));
  bot.command('materials', async (ctx) => showSection(ctx, 'materials'));
  bot.command('lessons',   async (ctx) => {
    const { showGroupList } = await import('./groups.js');
    return showGroupList(ctx);
  });

  bot.callbackQuery(/^entry:(\w+)$/, async (ctx) => {
    const answer = ctx.match[1];
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('users').update({ entry_answer: answer }).eq('id', user.id);
    await ctx.answerCallbackQuery();

    const section = ENTRY_SECTION[answer] ?? 'main';
    if (section === 'main') return showMain(ctx);
    if (section === 'lessons') {
      const { showGroupList } = await import('./groups.js');
      return showGroupList(ctx);
    }
    await showSection(ctx, section, T.entryAck[answer]);
  });

  bot.callbackQuery('menu:main', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMain(ctx);
  });

  // Постоянная кнопка внизу экрана
  bot.hears('☰ Меню', (ctx) => showMain(ctx));

  // Показать первый экран заново
  bot.command('start_over', async (ctx) => {
    await ctx.reply(T.welcome, { reply_markup: kbEntry(), parse_mode: 'HTML' });
  });

  bot.callbackQuery(/^menu:(materials|club)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSection(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^card:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const product = await db.getProduct(ctx.match[1]);
    if (!product) return ctx.answerCallbackQuery({ text: 'Продукт больше недоступен' });
    await showProduct(ctx, product);
  });

  // -------------------------------------------------------------------
  // Мой кабинет
  // -------------------------------------------------------------------
  bot.callbackQuery('menu:cabinet', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user   = await db.ensureUser(ctx.from);
    const orders = await db.userOrders(user.id);
    const paid   = orders.filter((o) => o.status === 'paid');

    if (!paid.length && !(await memberships(user.id)).length) {
      return screen(ctx, T.cabinetEmpty, kbBackMain());
    }

    const { InlineKeyboard } = await import('grammy');
    const kb = new InlineKeyboard();
    for (const o of paid.filter((o) => o.product_type === 'digital')) {
      kb.text(`⬇️ ${o.title_snapshot}`, `again:${o.id}`).row();
    }
    kb.text('← В главное меню', 'menu:main');

    const lines = paid.map(
      (o) => `• ${escapeHtml(o.title_snapshot)} — ${money(o.amount_eur)}`,
    );

    let text = `👤 <b>Мой кабинет</b>\n\nТвои покупки:\n${lines.join('\n')}`;

    const groups = await memberships(user.id);
    if (groups.length) {
      const gl = groups.map((m) => {
        const g = m.groups;
        const when = g.schedule_text ? ` · ${escapeHtml(g.schedule_text)}` : '';
        const paidTo = m.paid_until ? `оплачено до ${m.paid_until}` : 'ожидает оплаты';
        return `• ${escapeHtml(g.title)}${when} — ${paidTo}`;
      });
      text += `\n\n<b>Мои группы:</b>\n${gl.join('\n')}`;
    }
    await screen(ctx, text, kb);
  });

  // Повторная выдача файла
  bot.callbackQuery(/^again:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const order = await db.getOrder(ctx.match[1]);
    if (!order || order.status !== 'paid') return;
    const product = await db.getProduct(order.product_ref);
    const fileId = product?.payload?.file_id;
    if (!fileId) return ctx.reply('Файл временно недоступен — напиши мне, пришлю вручную.');
    await ctx.replyWithDocument(fileId, { caption: product.title });
  });
}
