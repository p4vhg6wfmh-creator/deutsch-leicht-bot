// src/ai.js — связь с Gemini.
// Ничего не знает про базу данных: только превращает текст в список команд.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const RULES = `Ты разбираешь сообщения учителя немецкого для её кабинета учёта.
Учитель пишет по-русски (иногда по-украински) свободным текстом.
Верни ТОЛЬКО JSON такого вида: {"actions":[...],"say":""}

Допустимые команды (поле "type"):
- add_lesson: student, date (YYYY-MM-DD), time ("HH:MM" или null), status ("planned"|"done"|"cancelled"|"noshow"), price (число в гривнах или null)
- set_status: student, date (YYYY-MM-DD), status ("done"|"cancelled"|"noshow")
- add_payment: student, amount (число в гривнах или null, если сумма не названа), kind ("single"|"package"|"other"), lessons (число уроков для package или null, если не названо)
- delete_lesson: student, date (YYYY-MM-DD)
- delete_last_payment: student
- reset_package: student, lessons (сколько уроков поставить на баланс; 0 = просто обнулить)
- report: period ("today"|"week"|"month")
- none: если сообщение не про учёт или не хватает данных. Тогда в "say" короткий вопрос или ответ.

Правила:
- В одном сообщении может быть несколько действий. Верни их все по порядку.
- student: имя ТОЧНО как в списке учеников, если оно похоже (падежи: «Ани» = «Аня»). Если в списке нет, пиши имя из сообщения в именительном падеже.
- Ничего не придумывай. Если не хватает даты или непонятно, о ком речь, верни none и спроси в "say".
- «провела / был урок / позанимались» = done. «не пришёл / не явился» = noshow. «отменили / отмена / перенесли» = cancelled. «запиши / будет / назначь» = planned.
- Дата: «сегодня» = сегодняшняя, «вчера», «завтра». День недели без даты: для прошедшего урока — ближайший такой день в прошлом (сегодня тоже подходит), для «запиши / будет» — ближайший в будущем.
- «оплатил занятие» без суммы: add_payment, kind "single", amount null.
- «оплатил абонемент»: add_payment, kind "package".
- «обнуляем абонемент / считаем заново / сбрось абонемент»: reset_package, lessons 0 (или то число, которое назвали).
- Массовые просьбы («удали всё», «сбрось все данные», «очисти базу») НЕ выполняй: верни none и в "say" объясни, что можно сбросить абонемент или удалить запись одного ученика.
- Все суммы в гривнах.`;
export async function parseMessage(text, { students, today, weekday }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { error: 'no_key' };

  const body = {
    systemInstruction: { parts: [{ text: RULES }] },
    contents: [{
      role: 'user',
      parts: [{
        text:
          `Сегодня: ${today} (${weekday}).\n` +
          `Ученики: ${students.length ? students.join(', ') : 'пока нет'}.\n\n` +
          `Сообщение:\n${text}`,
      }],
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 },
  };

  let res;
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(9000),
    });
  } catch (e) {
    console.error('GEMINI network', e?.message);
    return { error: 'fail', detail: `сеть: ${e?.message}` };
  }

  if (res.status === 429) return { error: 'limit' };
  if (!res.ok) {
    const msg = (await res.text()).slice(0, 300);
    console.error('GEMINI', res.status, msg);
    return { error: 'fail', detail: `${res.status} ${msg}` };
  }

  try {
    const data = await res.json();
    const raw = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '').join('')
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(raw);
    return {
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      say: typeof parsed.say === 'string' ? parsed.say : '',
    };
  } catch (e) {
    console.error('GEMINI parse', e?.message);
    return { error: 'fail', detail: `ответ не разобрать: ${e?.message}` };
  }
}
