import * as db from './db.js';
import {
  T, kbEntry, kbMain, kbProduct, kbBackMain, money, escapeHtml,
} from './ui.js';

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
  const [lessons, materials, club] = await Promise.all([
    db.countActive('lessons'),
    db.countActive('materials'),
    db.countActive('club'),
  ]);
  return kbMain({
    hasLessons:   lessons > 0,
    hasMaterials: materials > 0,
    hasClub:      club > 0,
  });
}

export async function showMain(ctx, edit = false) {
  const kb = await mainMenuKeyboard();
  const opts = { reply_markup: kb, parse_mode: 'HTML' };
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(T.mainMenu, opts).catch(() => ctx.reply(T.mainMenu, opts));
  } else {
    await ctx.reply(T.mainMenu, opts);
  }
}

export async function showSection(ctx, section, prefix = '') {
  const products = await db.listProducts(section);

  if (!products.length) {
    await ctx.editMessageText(T.emptySection, {
      reply_markup: kbBackMain(), parse_mode: 'HTML',
    }).catch(() => ctx.reply(T.emptySection, { reply_markup: kbBackMain() }));
    return;
  }

  // Один продукт в разделе — показываем карточку сразу
  if (products.length === 1) {
    await showProduct(ctx, products[0], prefix);
    return;
  }

  const { InlineKeyboard } = await import('grammy');
  const kb = new InlineKeyboard();
  for (const p of products) {
    kb.text(`${p.title} · ${money(p.price_eur)}`, `card:${p.id}`).row();
  }
  kb.text('← В главное меню', 'menu:main');

  const text = `${prefix}${prefix ? '\n\n' : ''}${SECTION_TITLES[section]}`;
  await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' })
    .catch(() => ctx.reply(text, { reply_markup: kb, parse_mode: 'HTML' }));
}

export async function showProduct(ctx, product, prefix = '') {
  const text =
    `${prefix}${prefix ? '\n\n' : ''}` +
    `<b>${escapeHtml(product.title)}</b>\n\n` +
    `${product.description ?? ''}\n\n` +
    `Стоимость: <b>${money(product.price_eur)}</b>`;

  const opts = { reply_markup: kbProduct(product), parse_mode: 'HTML' };
  await ctx.editMessageText(text, opts).catch(() => ctx.reply(text, opts));
}

// ---------------------------------------------------------------------
export function registerMenu(bot) {
  bot.command('start', async (ctx) => {
    const payload = ctx.match?.trim() || null;
    const user = await db.ensureUser(ctx.from, payload);
    await db.clearState(user.id);

    // Уже отвечал на входной вопрос — сразу в меню
    if (user.entry_answer) return showMain(ctx);

    await ctx.reply(T.welcome, { reply_markup: kbEntry(), parse_mode: 'HTML' });
  });

  bot.command('menu', (ctx) => showMain(ctx));
  bot.command('materials', async (ctx) => showSection(ctx, 'materials'));
  bot.command('lessons',   async (ctx) => showSection(ctx, 'lessons'));

  bot.callbackQuery(/^entry:(\w+)$/, async (ctx) => {
    const answer = ctx.match[1];
    const user = await db.ensureUser(ctx.from);
    await db.supabase.from('users').update({ entry_answer: answer }).eq('id', user.id);
    await ctx.answerCallbackQuery();

    const section = ENTRY_SECTION[answer] ?? 'main';
    if (section === 'main') return showMain(ctx, true);
    await showSection(ctx, section, T.entryAck[answer]);
  });

  bot.callbackQuery('menu:main', async (ctx) => {
    await ctx.answerCallbackQuery();
    await showMain(ctx, true);
  });

  bot.callbackQuery(/^menu:(lessons|materials|club)$/, async (ctx) => {
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

    if (!paid.length) {
      return ctx.editMessageText(T.cabinetEmpty, { reply_markup: kbBackMain() })
        .catch(() => ctx.reply(T.cabinetEmpty, { reply_markup: kbBackMain() }));
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
    const text = `👤 <b>Мой кабинет</b>\n\nТвои покупки:\n${lines.join('\n')}`;
    await ctx.editMessageText(text, { reply_markup: kb, parse_mode: 'HTML' })
      .catch(() => ctx.reply(text, { reply_markup: kb, parse_mode: 'HTML' }));
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
