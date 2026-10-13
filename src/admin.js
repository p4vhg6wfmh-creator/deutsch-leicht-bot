// src/ai.js — связь с Gemini.
// Ничего не знает про базу данных: только превращает текст в список команд.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// Порядок = приоритет. Если модель молчит дольше HEDGE_MS или отвечает ошибкой,
// параллельно запускается следующая; берём ответ той, что справилась первой.
const MODELS = [...new Set(['gemini-3.6-flash', MODEL, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'])];
const HEDGE_MS = 4000;      // через сколько мс без ответа подключать следующую модель
const DEADLINE_MS = 26000;  // дольше не ждём (Telegram ждёт ответ бота до ~30 секунд)
const GAP_FAST_MS = 300;    // пауза перед следующей моделью после быстрой ошибки
const GAP_SLOW_MS = 2500;   // то же на втором круге (когда все модели уже были с ошибкой)

// Насколько «думать»: чем меньше, тем быстрее ответ. Для разбора текста хватает минимума.
const LEVEL = {
  'gemini-3.6-flash': 'minimal',
  'gemini-3.5-flash-lite': 'minimal',
  'gemini-3.1-flash-lite': 'minimal',
};
// Модели, которым не подошла эта настройка — для них шлём запрос без неё.
const noThinking = new Set();

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
- «завтра будет Имя» = add_lesson, status "planned", дата завтрашняя, time и price null, если не названы.
- Дата: «сегодня» = сегодняшняя, «вчера», «завтра». День недели без даты: для прошедшего урока — ближайший такой день в прошлом (сегодня тоже подходит), для «запиши / будет» — ближайший в будущем.
- «оплатил занятие» без суммы: add_payment, kind "single", amount null.
- «оплатил абонемент»: add_payment, kind "package".
- Абонемент по умолчанию = 10 занятий. Если сказано, что абонемент оплачен раньше и с тех пор прошло N занятий — верни reset_package с lessons = 10 − N (или от того числа занятий, которое назвали). Новую оплату в этом случае НЕ добавляй, если сумма не названа.
- «обнуляем абонемент / считаем заново / сбрось абонемент»: reset_package, lessons 0 (или то число, которое назвали).
- Массовые просьбы («удали всё», «сбрось все данные», «очисти базу») НЕ выполняй: верни none и в "say" объясни, что можно сбросить абонемент или удалить запись одного ученика.
- Все суммы в гривнах.`;

export async function parseMessage(text, { students, today, weekday }) {
  // убираем случайные пробелы и кавычки, которые попадают при копировании
  const key = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']+|["']+$/g, '');
  if (!key) return { error: 'no_key' };

  const t0 = Date.now();
  const deadline = t0 + DEADLINE_MS;
  const controllers = new Set(); // чтобы оборвать лишние запросы, когда ответ уже есть
  const events = [];             // журнал для строки «для отладки»: что и когда происходило
  const sec = () => `${((Date.now() - t0) / 1000).toFixed(1)}с`;

  const makeBody = (model, withThinking) => JSON.stringify({
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
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0,
      ...(withThinking ? { thinkingConfig: { thinkingLevel: LEVEL[model] || 'low' } } : {}),
    },
  });

  // Один запрос к одной модели. Возвращает { value } или { err, fatal }.
  const call = async (model) => {
    const c = new AbortController();
    controllers.add(c);
    const timer = setTimeout(() => c.abort(), Math.max(500, deadline - Date.now()));
    const send = (withThinking) => fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: makeBody(model, withThinking),
        signal: c.signal,
      },
    );
    try {
      let res = await send(!noThinking.has(model));

      // Модель не приняла настройку обдумывания (400, но не из-за ключа) —
      // повторяем без неё и запоминаем это для модели.
      if (res.status === 400 && !noThinking.has(model)) {
        const msg = await res.clone().text();
        if (!/API_KEY_INVALID|API key/i.test(msg)) {
          noThinking.add(model);
          res = await send(false);
        }
      }

      if (res.status === 429) return { err: { error: 'limit' } };
      if (!res.ok) {
        const msg = (await res.text()).slice(0, 200);
        console.error('GEMINI', model, res.status, msg);
        return {
          err: { error: 'fail', detail: `${model}: ${res.status} ${msg}` },
          // проблема с ключом или запросом — другая модель не поможет
          fatal: [400, 401, 403].includes(res.status),
        };
      }

      const data = await res.json();
      const raw = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? '').join('')
        .replace(/^```(?:json)?\s*|\s*```$/g, '');
      const parsed = JSON.parse(raw);
      return {
        value: {
          actions: Array.isArray(parsed.actions) ? parsed.actions : [],
          say: typeof parsed.say === 'string' ? parsed.say : '',
        },
      };
    } catch (e) {
      const why = c.signal.aborted ? 'нет ответа вовремя'
        : e instanceof SyntaxError ? 'ответ не разобрать'
        : e?.message;
      console.error('GEMINI', model, why);
      return { err: { error: 'fail', detail: `${model}: ${why}` } };
    } finally {
      clearTimeout(timer);
      controllers.delete(c);
    }
  };

  // То же, но с записью в журнал.
  const run = async (model) => {
    const tag = model.replace('gemini-', '');
    events.push(`${sec()} ▶${tag}`);
    const r = await call(model);
    if (!r.value) {
      const why = String(r.err.detail ?? r.err.error).replace(`${model}: `, '').replace(/\s+/g, ' ').slice(0, 45);
      events.push(`${sec()} ✖${tag}: ${why}`);
    }
    return r;
  };

  // Запускаем модели по очереди с «подстраховкой»: следующая стартует, если предыдущая
  // слишком долго молчит или уже ответила ошибкой. Побеждает первая удачная.
  const order = [...MODELS, ...MODELS];
  return new Promise((resolve) => {
    let next = 0;
    let running = 0;
    let finished = false;
    let last = { error: 'fail' };
    let hedgeTimer = null;
    let gapTimer = null;
    let deadTimer = null;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(hedgeTimer);
      clearTimeout(gapTimer);
      clearTimeout(deadTimer);
      for (const c of controllers) c.abort();
      // при ошибке прикладываем журнал, чтобы было видно, какая модель что ответила
      resolve(result.error && result.error !== 'limit'
        ? { ...result, detail: `${result.detail?.startsWith('время вышло') ? 'время вышло. ' : ''}${events.join('; ')}` }
        : result);
    };

    deadTimer = setTimeout(() => finish({
      error: 'fail',
      detail: `время вышло (${Math.round(DEADLINE_MS / 1000)} с). ${last.detail ?? ''}`.trim(),
    }), DEADLINE_MS);

    const launch = () => {
      if (finished) return;
      clearTimeout(hedgeTimer);
      clearTimeout(gapTimer);
      if (next >= order.length) {
        if (running === 0) finish(last);
        return;
      }
      const model = order[next++];
      running++;
      run(model).then((r) => {
        running--;
        if (finished) return;
        if (r.value) { finish(r.value); return; }
        last = r.err;
        if (r.fatal) { finish(r.err); return; }
        gapTimer = setTimeout(launch, next >= MODELS.length ? GAP_SLOW_MS : GAP_FAST_MS);
      });
      hedgeTimer = setTimeout(launch, HEDGE_MS);
    };

    launch();
  });
}
