const https = require('https');
const http = require('http');
const { FRAMEWORK_PROMPT, PACKAGER_PROMPT } = require('./prompts');

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CONTENT_PLAN_DB = process.env.NOTION_DATABASE_ID;
const POSTS_DB = process.env.POSTS_DATABASE_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_ADMIN_ID = process.env.TG_ADMIN_ID;
const RUN_HOUR_MSK = parseInt(process.env.RUN_HOUR_MSK || '9', 10);

console.log('=== Переводчики сердца: бот запущен ===');
console.log('Время старта:', new Date().toISOString());
console.log('Запуск планируется в', RUN_HOUR_MSK + ':00 МСК');

// === HTTP-ЗАПРОС ===
function apiRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqHeaders = Object.assign({}, headers || {});
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

// === NOTION ===
const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28'
};

async function queryDatabase(dbId, filter) {
  const body = filter ? { filter } : {};
  body.page_size = 100;
  return apiRequest('api.notion.com', `/v1/databases/${dbId}/query`, 'POST', NOTION_HEADERS, body);
}

async function updatePage(pageId, properties) {
  return apiRequest('api.notion.com', `/v1/pages/${pageId}`, 'PATCH', NOTION_HEADERS, { properties });
}

function getProp(props, name) {
  const p = props[name];
  if (!p) return null;
  if (p.title && p.title.length) return p.title.map(t => t.plain_text).join('');
  if (p.rich_text && p.rich_text.length) return p.rich_text.map(t => t.plain_text).join('');
  if (p.select) return p.select.name;
  if (p.status) return p.status.name;
  if (p.date) return p.date.start;
  return null;
}

function richText(text) {
  if (!text) return { rich_text: [] };
  // Notion ограничивает rich_text до 2000 символов на блок
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) {
    chunks.push({ type: 'text', text: { content: text.substring(i, i + 1900) } });
  }
  return { rich_text: chunks };
}

// === CLAUDE ===
async function claude(prompt, maxTokens) {
  const result = await apiRequest(
    'api.anthropic.com', '/v1/messages',
    'POST',
    { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    { model: 'claude-sonnet-4-20250514', max_tokens: maxTokens || 2000, messages: [{ role: 'user', content: prompt }] }
  );
  if (!result.content) throw new Error('Claude error: ' + JSON.stringify(result).substring(0, 300));
  return result.content.map(c => c.text || '').join('').trim();
}

// === TELEGRAM ===
async function notify(text) {
  if (!TG_BOT_TOKEN || !TG_ADMIN_ID) return;
  await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendMessage`, 'POST', {},
    { chat_id: TG_ADMIN_ID, text: text, parse_mode: 'Markdown', disable_web_page_preview: true });
}

// === ОСНОВНАЯ ЛОГИКА ===
function today() {
  // Дата по МСК в формате YYYY-MM-DD
  const now = new Date();
  const msk = new Date(now.getTime() + (3 * 60 - now.getTimezoneOffset()) * 60000);
  return msk.toISOString().substring(0, 10);
}

async function findTodayPlanned() {
  const result = await queryDatabase(CONTENT_PLAN_DB, {
    property: 'Дата',
    date: { equals: today() }
  });
  if (!result.results) throw new Error('Контент-план: ' + JSON.stringify(result).substring(0, 200));
  return result.results;
}

async function findPostByTitle(title) {
  const result = await queryDatabase(POSTS_DB, {
    property: 'Тема',
    title: { equals: title }
  });
  if (!result.results || result.results.length === 0) return null;
  return result.results[0];
}

async function processPost(planEntry) {
  const title = getProp(planEntry.properties, 'Пост');
  console.log('Обрабатываю:', title);
  
  if (!title) {
    console.log('У записи нет названия, пропускаю');
    return null;
  }
  
  const post = await findPostByTitle(title);
  if (!post) {
    console.log('В базе Посты не найдена карточка с названием:', title);
    await notify(`⚠️ Нет карточки в Постах: *${title}*\n\nСоздай её и запусти бот ещё раз.`);
    return null;
  }
  
  const props = post.properties;
  let framework = getProp(props, 'Каркас (ChatGPT)') || getProp(props, 'Каркас');
  let tgText = getProp(props, 'TG-текст');
  let dzenText = getProp(props, 'Dzen-текст');
  let vkText = getProp(props, 'VK-текст');
  
  const updates = {};
  let workDone = [];
  
  // ШАГ 1: каркас
  if (!framework || framework.length < 100) {
    console.log('Генерирую каркас...');
    framework = await claude(`${FRAMEWORK_PROMPT}\n\nТЕМА: ${title}`, 3000);
    const frameworkField = props['Каркас (ChatGPT)'] ? 'Каркас (ChatGPT)' : 'Каркас';
    updates[frameworkField] = richText(framework);
    workDone.push('каркас');
  }
  
  // ШАГ 2: упаковка
  if (!tgText || tgText.length < 100) {
    console.log('Упаковываю в форматы...');
    const packed = await claude(`${PACKAGER_PROMPT}\n\nКАРКАС:\n${framework}`, 4000);
    
    // Парсим блоки
    const tgMatch = packed.match(/=== TELEGRAM ===\s*([\s\S]*?)(?:=== DZEN|===|$)/);
    const dzenMatch = packed.match(/=== DZEN ===\s*([\s\S]*?)(?:=== VK|===|$)/);
    const vkMatch = packed.match(/=== VK ===\s*([\s\S]*?)$/);
    
    if (tgMatch) updates['TG-текст'] = richText(tgMatch[1].trim());
    if (dzenMatch) updates['Dzen-текст'] = richText(dzenMatch[1].trim());
    if (vkMatch) updates['VK-текст'] = richText(vkMatch[1].trim());
    workDone.push('тексты под платформы');
  }
  
  if (Object.keys(updates).length > 0) {
    await updatePage(post.id, updates);
    const postUrl = `https://www.notion.so/${post.id.replace(/-/g, '')}`;
    await notify(
      `✅ *${title}*\n\nСгенерировал: ${workDone.join(', ')}\n\n[Открыть в Notion](${postUrl})\n\nПроверь и поставь статус Утверждено.`
    );
    return title;
  }
  
  console.log('У поста уже всё сгенерировано, пропускаю');
  return null;
}

async function runDaily() {
  console.log('\n=== Цикл генерации:', new Date().toISOString(), '===');
  try {
    const planned = await findTodayPlanned();
    console.log('На сегодня запланировано постов:', planned.length);
    
    if (planned.length === 0) {
      console.log('Постов на сегодня нет, цикл завершён');
      return;
    }
    
    const processed = [];
    for (const entry of planned) {
      try {
        const result = await processPost(entry);
        if (result) processed.push(result);
      } catch (e) {
        console.error('Ошибка обработки:', e.message);
        await notify(`⚠️ Ошибка при обработке поста: ${e.message}`);
      }
    }
    
    console.log('Обработано постов:', processed.length);
  } catch (e) {
    console.error('Ошибка цикла:', e.message);
    await notify(`⚠️ *Ошибка ежедневного цикла*\n\n${e.message}`);
  }
}

// === ПЛАНИРОВЩИК (раз в день в RUN_HOUR_MSK) ===
let lastRunDate = null;

function checkAndRun() {
  const now = new Date();
  const mskOffset = (3 * 60 - now.getTimezoneOffset()) * 60000;
  const msk = new Date(now.getTime() + mskOffset);
  const currentHour = msk.getUTCHours();
  const dateKey = msk.toISOString().substring(0, 10);
  
  if (currentHour === RUN_HOUR_MSK && lastRunDate !== dateKey) {
    lastRunDate = dateKey;
    console.log('Запуск ежедневного цикла, время МСК:', msk.toISOString());
    runDaily();
  }
}

// Проверка каждые 5 минут
setInterval(checkAndRun, 5 * 60 * 1000);
checkAndRun(); // и сразу при старте

// === HEALTHCHECK ===
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Perevodchiki bot is alive. Next run hour MSK: ' + RUN_HOUR_MSK + '\n');
}).listen(process.env.PORT || 3000);
