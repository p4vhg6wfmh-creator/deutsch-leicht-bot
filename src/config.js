// ---------------------------------------------------------------------
// Имена таблиц собраны здесь намеренно.
// Если бот живёт в ОБЩЕЙ базе с TutorTrack и имена конфликтуют —
// поменяй значения на 'bot_users', 'bot_products' и т.д.
// Больше нигде в коде имена таблиц не встречаются.
// ---------------------------------------------------------------------
export const TABLES = {
  users:    'users',
  products: 'products',
  orders:   'orders',
  settings: 'settings',
};

export const ENV = {
  BOT_TOKEN:            process.env.BOT_TOKEN,
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  ADMIN_CHAT_ID:        process.env.ADMIN_CHAT_ID,
  WEBHOOK_SECRET:       process.env.WEBHOOK_SECRET,
  // tg_id владельца — только он может подтверждать оплаты
  OWNER_TG_ID:          process.env.OWNER_TG_ID,
};

// Способы оплаты: ключ → подпись на кнопке + ключ реквизитов в settings
export const PAY_METHODS = {
  paypal: { label: '💳 PayPal',            settingsKey: 'requisites_paypal' },
  card:   { label: '💶 Еврокарта Monobank', settingsKey: 'requisites_card'   },
  sepa:   { label: '🏦 SEPA / IBAN',        settingsKey: 'requisites_sepa'   },
};
