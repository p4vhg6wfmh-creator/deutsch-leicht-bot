import { createClient } from '@supabase/supabase-js';
import { TABLES, ENV } from './config.js';

export const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------
// SETTINGS  (кэш на минуту — контейнер переиспользуется между вызовами)
// ---------------------------------------------------------------------
let _cache = null;
let _cachedAt = 0;

export async function getSettings(force = false) {
  if (!force && _cache && Date.now() - _cachedAt < 60_000) return _cache;
  const { data, error } = await supabase.from(TABLES.settings).select('key, value');
  if (error) throw error;
  _cache = Object.fromEntries(data.map((r) => [r.key, r.value]));
  _cachedAt = Date.now();
  return _cache;
}

// ---------------------------------------------------------------------
// USERS
// ---------------------------------------------------------------------
export async function ensureUser(from, startPayload = null) {
  const { data: existing } = await supabase
    .from(TABLES.users)
    .select('*')
    .eq('tg_id', from.id)
    .maybeSingle();

  if (existing) {
    // обновляем только то, что могло измениться в профиле
    const patch = {};
    if (existing.username !== from.username) patch.username = from.username ?? null;
    if (existing.first_name !== from.first_name) patch.first_name = from.first_name ?? null;
    if (!existing.source && startPayload) patch.source = startPayload;
    if (existing.is_blocked) patch.is_blocked = false;

    if (Object.keys(patch).length) {
      const { data } = await supabase
        .from(TABLES.users).update(patch).eq('id', existing.id).select().single();
      return data;
    }
    return existing;
  }

  const { data, error } = await supabase
    .from(TABLES.users)
    .insert({
      tg_id:      from.id,
      username:   from.username ?? null,
      first_name: from.first_name ?? null,
      source:     startPayload,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function setState(userId, state, stateData = {}) {
  await supabase
    .from(TABLES.users)
    .update({ state, state_data: stateData })
    .eq('id', userId);
}

export async function clearState(userId) {
  await setState(userId, null, {});
}

export async function getUserByTgId(tgId) {
  const { data } = await supabase
    .from(TABLES.users).select('*').eq('tg_id', tgId).maybeSingle();
  return data;
}

export async function markBlocked(userId) {
  await supabase.from(TABLES.users).update({ is_blocked: true }).eq('id', userId);
}

// ---------------------------------------------------------------------
// PRODUCTS
// ---------------------------------------------------------------------
export async function listProducts(section) {
  const { data, error } = await supabase
    .from(TABLES.products)
    .select('*')
    .eq('section', section)
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function countActive(section) {
  const { count } = await supabase
    .from(TABLES.products)
    .select('id', { count: 'exact', head: true })
    .eq('section', section)
    .eq('is_active', true);
  return count ?? 0;
}

export async function getProduct(id) {
  const { data } = await supabase
    .from(TABLES.products).select('*').eq('id', id).maybeSingle();
  return data;
}

// ---------------------------------------------------------------------
// ORDERS
// ---------------------------------------------------------------------
export async function createOrder(user, product) {
  const { data, error } = await supabase
    .from(TABLES.orders)
    .insert({
      user_id:        user.id,
      product_type:   product.type,
      product_ref:    product.id,
      title_snapshot: product.title,
      amount_eur:     product.price_eur,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getOrder(id) {
  const { data } = await supabase
    .from(TABLES.orders).select('*').eq('id', id).maybeSingle();
  return data;
}

export async function updateOrder(id, patch) {
  const { data, error } = await supabase
    .from(TABLES.orders).update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

// Атомарное подтверждение — защита от двойного нажатия «Подтвердить».
// Вернёт null, если заказ уже был обработан.
export async function confirmOrder(orderId, adminTgId) {
  const { data, error } = await supabase
    .rpc('confirm_order', { p_order_id: orderId, p_admin_tg_id: adminTgId });
  if (error) throw error;
  return data?.[0] ?? null;
}

export async function userOrders(userId) {
  const { data } = await supabase
    .from(TABLES.orders)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  return data ?? [];
}

export async function paidDigitalOrders(userId) {
  const { data } = await supabase
    .from(TABLES.orders)
    .select('*')
    .eq('user_id', userId)
    .eq('product_type', 'digital')
    .eq('status', 'paid');
  return data ?? [];
}
