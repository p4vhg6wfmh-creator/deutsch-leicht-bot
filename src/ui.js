import { InlineKeyboard } from 'grammy';
import { PAY_METHODS } from './config.js';

// ---------------------------------------------------------------------
// Форматирование
// ---------------------------------------------------------------------
export function money(amount) {
  const n = Number(amount);
  return Number.isInteger(n) ? `${n} €` : `${n.toFixed(2).replace('.', ',')} €`;
}

export function escapeHtml(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Рабочее ли сейчас время у владельца
export function isWorkingHours(settings) {
  const tz    = settings.working_timezone   || 'Europe/Kyiv';
  const start = settings.working_hours_start || '09:00';
  const end   = settings.working_hours_end   || '21:00';
  const now = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  return now >= start && now <= end;
}

// ---------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------
export const T = {
  welcome:
    'Привет! Это бот <b>Deutsch bewusst</b>.\n\n' +
    'Здесь немецкий — не про зубрёжку, а про то, чтобы понимать, ' +
    'как язык устроен, и двигаться без насилия над собой.\n\n' +
    'Чтобы я показал то, что тебе сейчас нужнее — скажи, что ближе:',

  entryAck: {
    zero:     'Отлично, с нуля — самый честный старт. Вот что подойдёт:',
    speaking: 'Знакомая история: понимаю, а сказать не могу. Смотри:',
    self:     'Тогда держи материалы для самостоятельной работы:',
    browsing: 'Конечно, смотри спокойно. Вот всё, что есть:',
  },

  mainMenu: 'Главное меню — выбирай раздел:',

  emptySection: 'Здесь пока пусто — скоро появится. Загляни в другие разделы.',

  askSender:
    'Спасибо! Последний вопрос: <b>как звучит имя отправителя платежа?</b>\n\n' +
    'Оно часто не совпадает с ником в Telegram — это поможет мне быстро найти твой перевод.',

  askReceipt:
    'Пришли, пожалуйста, <b>квитанцию или скриншот перевода</b> — фото или файл.',

  notAReceipt: 'Жду именно квитанцию — фото или файл. Или нажми «Отмена», если передумала.',

  cancelled: 'Заказ отменён. Возвращайся, когда будет удобно 🙂',

  cabinetEmpty: 'Пока здесь пусто. Как только что-то купишь — появится тут.',

  contact:
    'Напиши сообщение прямо сюда — я его получу и отвечу лично.\n\n' +
    'Просто следующим сообщением.',

  contactSent: 'Сообщение отправлено — отвечу, как только увижу 🙌',
};

// ---------------------------------------------------------------------
// Клавиатуры
// ---------------------------------------------------------------------
export function kbEntry() {
  return new InlineKeyboard()
    .text('🌱 Начинаю с нуля', 'entry:zero').row()
    .text('🗣 Учил(а), но не говорю', 'entry:speaking').row()
    .text('📖 Учу сам(а), нужны материалы', 'entry:self').row()
    .text('👀 Просто посмотреть, что есть', 'entry:browsing');
}

export function kbMain({ hasLessons, hasMaterials, hasClub }) {
  const kb = new InlineKeyboard();
  if (hasLessons)   kb.text('📚 Занятия с преподавателем', 'menu:lessons').row();
  if (hasMaterials) kb.text('🎧 Материалы и курсы', 'menu:materials').row();
  if (hasClub)      kb.text('🔑 Клуб Deutsch bewusst', 'menu:club').row();
  kb.text('👤 Мой кабинет', 'menu:cabinet').row();
  kb.text('💬 Написать мне', 'menu:contact');
  return kb;
}

export function kbProduct(product) {
  return new InlineKeyboard()
    .text(`Купить · ${money(product.price_eur)}`, `buy:${product.id}`).row()
    .text('← Назад', `menu:${product.section}`);
}

export function kbPayMethods(orderId) {
  const kb = new InlineKeyboard();
  for (const [key, m] of Object.entries(PAY_METHODS)) {
    kb.text(m.label, `pay:${orderId}:${key}`).row();
  }
  kb.text('← Отмена', `cancel:${orderId}`);
  return kb;
}

export function kbPaid(orderId) {
  return new InlineKeyboard()
    .text('✅ Я оплатил(а)', `paid:${orderId}`).row()
    .text('← Отмена', `cancel:${orderId}`);
}

export function kbBackMain() {
  return new InlineKeyboard().text('← В главное меню', 'menu:main');
}

export function kbAdmin(orderId) {
  return new InlineKeyboard()
    .text('✅ Подтвердить', `adm:ok:${orderId}`)
    .text('❌ Отклонить', `adm:no:${orderId}`).row()
    .text('✍️ Уточнить', `adm:ask:${orderId}`);
}
