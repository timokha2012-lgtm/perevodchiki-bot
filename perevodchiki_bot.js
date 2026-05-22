const https = require('https');
const http = require('http');

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (заполняются в Railway) ===
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_ADMIN_ID = process.env.TG_ADMIN_ID;

console.log('=== Переводчики сердца: бот запущен ===');
console.log('Время старта:', new Date().toISOString());
console.log('NOTION_TOKEN:', NOTION_TOKEN ? 'установлен' : 'НЕТ');
console.log('NOTION_DATABASE_ID:', NOTION_DATABASE_ID ? 'установлен' : 'НЕТ');
console.log('ANTHROPIC_KEY:', ANTHROPIC_KEY ? 'установлен' : 'НЕТ');
console.log('TG_BOT_TOKEN:', TG_BOT_TOKEN ? 'установлен' : 'НЕТ');
console.log('TG_ADMIN_ID:', TG_ADMIN_ID ? 'установлен' : 'НЕТ');

// === УНИВЕРСАЛЬНЫЙ HTTPS-ЗАПРОС ===
function apiRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqHeaders = Object.assign({}, headers);
    if (bodyStr) {
      reqHeaders['Content-Type'] = 'application/json';
      reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request({ hostname, path, method, headers: reqHeaders }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: 'parse_error', raw: data, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// === NOTION: ЧИТАЕМ КОНТЕНТ-ПЛАН ===
async function fetchContentPlan() {
  if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
    throw new Error('Не заданы NOTION_TOKEN или NOTION_DATABASE_ID');
  }
  const result = await apiRequest(
    'api.notion.com',
    `/v1/databases/${NOTION_DATABASE_ID}/query`,
    'POST',
    {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28'
    },
    { page_size: 100 }
  );
  if (!result.results) {
    throw new Error('Notion вернул ошибку: ' + JSON.stringify(result));
  }
  return result.results;
}

// === ПАРСИМ ЗАПИСЬ ИЗ КОНТЕНТ-ПЛАНА ===
function parseEntry(entry) {
  const props = entry.properties || {};
  const getText = (name) => {
    const p = props[name];
    if (!p) return null;
    if (p.title) return (p.title[0] || {}).plain_text || null;
    if (p.rich_text) return (p.rich_text[0] || {}).plain_text || null;
    if (p.select) return (p.select || {}).name || null;
    if (p.date) return (p.date || {}).start || null;
    return null;
  };
  return {
    дата: getText('Дата'),
    пост: getText('Пост'),
    серия: getText('Серия'),
    статус: getText('Статус'),
    время: getText('Время'),
    платформы: getText('Платформы')
  };
}

// === TELEGRAM: ОТПРАВКА АДМИНУ ===
async function notifyAdmin(text) {
  if (!TG_BOT_TOKEN || !TG_ADMIN_ID) {
    console.log('TG-уведомления отключены (нет токена или ID)');
    return;
  }
  try {
    const res = await apiRequest(
      'api.telegram.org',
      `/bot${TG_BOT_TOKEN}/sendMessage`,
      'POST',
      {},
      { chat_id: TG_ADMIN_ID, text: text, parse_mode: 'Markdown' }
    );
    if (!res.ok) console.log('TG-ошибка:', JSON.stringify(res));
  } catch (e) {
    console.error('Ошибка отправки в TG:', e.message);
  }
}

// === ОСНОВНОЙ ЦИКЛ ===
async function runOnce() {
  console.log('\n--- Запуск цикла:', new Date().toISOString(), '---');
  try {
    const entries = await fetchContentPlan();
    console.log('Найдено записей в Контент-плане:', entries.length);
    const parsed = entries.map(parseEntry);
    parsed.forEach((p, i) => {
      console.log(`${i+1}. [${p.дата || '?'}] ${p.пост || '?'} | серия: ${p.серия || '-'} | статус: ${p.статус || '-'}`);
    });
    const top5 = parsed.slice(0, 5).map(p =>
      `• ${p.дата || '?'} — ${p.пост || '?'} (${p.статус || '?'})`
    ).join('\n');
    await notifyAdmin(
      `🤖 *Переводчики бот: тест чтения Notion*\n\n` +
      `Найдено записей: ${entries.length}\n\n` +
      `Первые 5:\n${top5 || '(пусто)'}`
    );
    console.log('Цикл завершён успешно');
  } catch (e) {
    console.error('Ошибка цикла:', e.message);
    await notifyAdmin(`⚠️ *Переводчики бот: ошибка*\n\n${e.message}`);
  }
}

// === ЗАПУСК ===
runOnce();
setInterval(runOnce, 60 * 60 * 1000); // повтор раз в час

// === HEALTHCHECK ДЛЯ RAILWAY ===
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Perevodchiki bot is alive\n');
}).listen(process.env.PORT || 3000, () => {
  console.log('HTTP healthcheck слушает порт', process.env.PORT || 3000);
});
