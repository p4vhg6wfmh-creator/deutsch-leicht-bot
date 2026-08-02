import * as db from './db.js';
import { deliverCohort } from './groups.js';
import { deliverLesson, deliverPackage } from './lessons.js';
import { PAY_METHODS, ENV } from './config.js';
import {
  T, kbPayMethods, kbPaid, kbAdmin, kbBackMain,
  money, escapeHtml, isWorkingHours,
} from './ui.js';

const STATE = {
  RECEIPT: 'awaiting_receipt',
  SENDER:  'awaiting_sender',
  CONTACT: 'awaiting_contact',
  ADMIN_ASK: 'admin_asking',
};

// ---------------------------------------------------------------------
// Выдача доступа. Идемпотентна: повторный вызов ничего не сделает.
// ---------------------------------------------------------------------
export async function deliver(bot, order) {
  if (order.delivered_at) return;

  const { data: user } = await db.supabase
    .from('users').select('tg_id').eq('id', order.user_id).single();

  if (order.product_type === 'digital') {
    const product = await db.getProduct(order.product_ref);
    const fileId = product?.payload?.file_id;

    if (fileId) {
      await bot.api.sendDocument(user.tg_id, fileId, {
        caption:
          `Готово! Вот твой «${product.title}» 🎉\n\n` +
          `Файл всегда можно скачать заново в разделе «Мой кабинет».`,
      });
    } else {
      await bot.api.sendMessage(
        user.tg_id,
        'Оплата подтверждена! Файл пришлю в ближайшее время вручную 🙏',
      );
      await bot.api.sendMessage(
        ENV.ADMIN_CHAT_ID,
        `⚠️ У продукта нет file_id — отправь файл вручную. Заказ ${order.code}`,
      );
    }
  } else if (order.product_type === 'cohort') {
    await deliverCohort(bot, order, user.tg_id);
  } else if (order.product_type === 'lesson') {
    await deliverLesson(bot, order, user.tg_id);
  } else if (order.product_type === 'package') {
    await deliverPackage(bot, order, user.tg_id);
  } else {
    // subscription — этап 5
    await bot.api.sendMessage(
      user.tg_id,
      'Оплата подтверждена! Свяжусь с тобой с деталями в ближайшее время 🙌',
    );
  }

  await db.updateOrder(order.id, { delivered_at: new Date().toISOString() });
}

// ---------------------------------------------------------------------
export function registerPayment(bot) {
  // --- Купить → выбор способа оплаты ---------------------------------
  bot.callbackQuery(/^buy:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const product = await db.getProduct(ctx.match[1]);
    if (!product || !product.is_active) {
      return ctx.reply('Этот продукт сейчас недоступен.', { reply_markup: kbBackMain() });
    }

    const user  = await db.ensureUser(ctx.from);
    const order = await db.createOrder(user, product);

    const text =
      `<b>${escapeHtml(product.title)}</b>\n` +
      `К оплате: <b>${money(order.amount_eur)}</b>\n\n` +
      `Выбери удобный способ оплаты:`;

    await ctx.editMessageText(text, {
      reply_markup: kbPayMethods(order.id), parse_mode: 'HTML',
    }).catch(() => ctx.reply(text, { reply_markup: kbPayMethods(order.id), parse_mode: 'HTML' }));
  });

  // --- Способ выбран → показываем реквизиты --------------------------
  bot.callbackQuery(/^pay:([^:]+):(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, orderId, method] = ctx.match;

    const order = await db.getOrder(orderId);
    if (!order || order.status !== 'created') {
      return ctx.reply('Этот заказ уже неактуален. Начни заново через меню.', {
        reply_markup: kbBackMain(),
      });
    }

    await db.updateOrder(orderId, { method });
    const settings = await db.getSettings();
    const cfg = PAY_METHODS[method];
    const requisites = settings[cfg.settingsKey] || '— реквизиты не заполнены —';

    // Реквизиты отдельным сообщением: копируются в одно касание
    await ctx.editMessageText(
      `${cfg.label}\n\nРеквизиты для перевода:`,
      { parse_mode: 'HTML' },
    ).catch(() => {});

    await ctx.reply(`<code>${escapeHtml(requisites)}</code>`, { parse_mode: 'HTML' });

    let tail = order.amount_flexible
      ? `Комментарий к переводу (если есть поле): <code>${order.code}</code>\n\n` +
        `Переведи сумму по прайсу и нажми кнопку ниже — пришли квитанцию.`
      : `Сумма: <b>${money(order.amount_eur)}</b>\n` +
        `Комментарий к переводу (если есть поле): <code>${order.code}</code>\n\n` +
        `Как переведёшь — нажми кнопку ниже и пришли квитанцию.`;

    if (method === 'paypal' && settings.paypal_fee_note) {
      tail = `${settings.paypal_fee_note}\n\n${tail}`;
    }

    await ctx.reply(tail, { reply_markup: kbPaid(orderId), parse_mode: 'HTML' });
  });

  // --- «Я оплатил(а)» → ждём квитанцию -------------------------------
  bot.callbackQuery(/^paid:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = ctx.match[1];
    const order = await db.getOrder(orderId);
    if (!order || !['created', 'awaiting'].includes(order.status)) return;

    const user = await db.ensureUser(ctx.from);
    await db.setState(user.id, STATE.RECEIPT, { order_id: orderId });
    await ctx.reply(T.askReceipt, { parse_mode: 'HTML' });
  });

  // --- Отмена --------------------------------------------------------
  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await db.updateOrder(ctx.match[1], { status: 'expired' });
    const user = await db.ensureUser(ctx.from);
    await db.clearState(user.id);
    await ctx.reply(T.cancelled, { reply_markup: kbBackMain() });
  });

  // --- Приём квитанции ------------------------------------------------
  bot.on(['message:photo', 'message:document'], async (ctx, next) => {
    const user = await db.ensureUser(ctx.from);

    // В админ-чате бот вместо этого показывает file_id — удобно для минибука
    if (String(ctx.chat.id) === String(ENV.ADMIN_CHAT_ID)) {
      const fileId = ctx.message.document?.file_id
        ?? ctx.message.photo?.at(-1)?.file_id;
      return ctx.reply(`file_id:\n<code>${fileId}</code>`, { parse_mode: 'HTML' });
    }

    if (user.state !== STATE.RECEIPT) return next();

    const fileId = ctx.message.document?.file_id ?? ctx.message.photo.at(-1).file_id;
    const orderId = user.state_data.order_id;

    await db.updateOrder(orderId, { receipt_file_id: fileId });
    await db.setState(user.id, STATE.SENDER, { order_id: orderId });
    await ctx.reply(T.askSender, { parse_mode: 'HTML' });
  });

  // --- Приём имени отправителя → заявка владельцу ---------------------
  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text?.startsWith('/')) return next();
    const user = await db.ensureUser(ctx.from);

    // --- Уточняющее сообщение от владельца клиенту ---
    if (user.state === STATE.ADMIN_ASK) {
      const { order_id } = user.state_data;
      const order = await db.getOrder(order_id);
      const { data: client } = await db.supabase
        .from('users').select('tg_id').eq('id', order.user_id).single();
      await ctx.api.sendMessage(client.tg_id, ctx.message.text);
      await db.clearState(user.id);
      return ctx.reply('Отправлено клиенту ✅');
    }

    // --- Свободное сообщение владельцу ---
    if (user.state === STATE.CONTACT) {
      await ctx.api.sendMessage(
        ENV.ADMIN_CHAT_ID,
        `💬 Сообщение от ${escapeHtml(user.first_name ?? '')} ` +
        `${user.username ? '@' + user.username : `(id ${user.tg_id})`}:\n\n` +
        escapeHtml(ctx.message.text),
        { parse_mode: 'HTML' },
      );
      await db.clearState(user.id);
      return ctx.reply(T.contactSent);
    }

    if (user.state !== STATE.SENDER) return next();

    const orderId = user.state_data.order_id;
    const order = await db.updateOrder(orderId, {
      sender_name:  ctx.message.text.slice(0, 120),
      status:       'awaiting',
      submitted_at: new Date().toISOString(),
    });
    await db.clearState(user.id);

    const settings = await db.getSettings();
    const reply = isWorkingHours(settings)
      ? settings.text_paid_working
      : settings.text_paid_offhours;
    await ctx.reply(reply);

    // Карточка владельцу
    const caption =
      `🧾 <b>Новая оплата</b>\n\n` +
      `Заказ: <code>${order.code}</code>\n` +
      `Продукт: ${escapeHtml(order.title_snapshot)}\n` +
      `Сумма: <b>${money(order.amount_eur)}</b>\n` +
      `Способ: ${PAY_METHODS[order.method]?.label ?? order.method}\n` +
      `Отправитель: <b>${escapeHtml(order.sender_name)}</b>\n` +
      `Клиент: ${escapeHtml(user.first_name ?? '')} ` +
      `${user.username ? '@' + user.username : `(id ${user.tg_id})`}`;

    await ctx.api.sendDocument(ENV.ADMIN_CHAT_ID, order.receipt_file_id, {
      caption, parse_mode: 'HTML', reply_markup: kbAdmin(order.id),
    }).catch(async () => {
      await ctx.api.sendPhoto(ENV.ADMIN_CHAT_ID, order.receipt_file_id, {
        caption, parse_mode: 'HTML', reply_markup: kbAdmin(order.id),
      });
    });
  });

  // --- Кнопка «Написать мне» -----------------------------------------
  bot.callbackQuery('menu:contact', async (ctx) => {
    await ctx.answerCallbackQuery();
    const user = await db.ensureUser(ctx.from);
    await db.setState(user.id, STATE.CONTACT, {});
    await ctx.reply(T.contact);
  });

  // -------------------------------------------------------------------
  // АДМИН: подтвердить / отклонить / уточнить
  // -------------------------------------------------------------------
  bot.callbackQuery(/^adm:(ok|no|ask):(.+)$/, async (ctx) => {
    const [, action, orderId] = ctx.match;

    // Право подтверждать есть только у владельца
    if (ENV.OWNER_TG_ID && String(ctx.from.id) !== String(ENV.OWNER_TG_ID)) {
      return ctx.answerCallbackQuery({
        text: 'Подтверждать оплаты может только владелец', show_alert: true,
      });
    }

    const order = await db.getOrder(orderId);
    if (!order) return ctx.answerCallbackQuery({ text: 'Заказ не найден' });

    const { data: client } = await db.supabase
      .from('users').select('tg_id').eq('id', order.user_id).single();

    if (action === 'ok') {
      const confirmed = await db.confirmOrder(orderId, ctx.from.id);
      if (!confirmed) {
        return ctx.answerCallbackQuery({ text: 'Уже обработан', show_alert: true });
      }
      await ctx.answerCallbackQuery({ text: 'Подтверждено ✅' });
      await ctx.editMessageCaption({
        caption: `${ctx.callbackQuery.message.caption}\n\n✅ <b>ПОДТВЕРЖДЕНО</b>`,
        parse_mode: 'HTML',
      }).catch(() => {});
      await deliver(bot, confirmed);
      return;
    }

    if (action === 'no') {
      await db.updateOrder(orderId, { status: 'rejected' });
      await ctx.answerCallbackQuery({ text: 'Отклонено' });
      await ctx.editMessageCaption({
        caption: `${ctx.callbackQuery.message.caption}\n\n❌ <b>ОТКЛОНЕНО</b>`,
        parse_mode: 'HTML',
      }).catch(() => {});
      await bot.api.sendMessage(
        client.tg_id,
        'Не получилось найти твой платёж 🙏 Напиши мне — разберёмся вместе.',
      );
      return;
    }

    // ask — владелец пишет клиенту вопрос
    const owner = await db.ensureUser(ctx.from);
    await db.setState(owner.id, STATE.ADMIN_ASK, { order_id: orderId });
    await ctx.answerCallbackQuery();
    await ctx.reply('Напиши сообщение — я перешлю его клиенту.');
  });
}
