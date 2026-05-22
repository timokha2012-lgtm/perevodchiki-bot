const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { FRAMEWORK_PROMPT, PACKAGER_PROMPT } = require('./prompts');

// === ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ ===
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CONTENT_PLAN_DB = process.env.NOTION_DATABASE_ID;
const POSTS_DB = process.env.POSTS_DATABASE_ID;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_ADMIN_ID = process.env.TG_ADMIN_ID;
const RUN_HOUR_MSK = parseInt(process.env.RUN_HOUR_MSK || '9', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IMAGE_STYLE = process.env.IMAGE_STYLE || 'minimalist symbolic illustration, dark background, single strong metaphor, no text, cinematic light, christian psychology theme';

console.log('=== Переводчики сердца: бот запущен ===');
console.log('Время старта:', new Date().toISOString());
console.log('Запуск планируется в', RUN_HOUR_MSK + ':00 МСК');

// === HTTP-ЗАПРОС ===
function apiRequest(hostname, path, method, headers, body, isForm) {
  return new Promise((resolve, reject) => {
    let bodyStr = null;
    const reqHeaders = Object.assign({}, headers || {});
    if (body !== undefined && body !== null) {
      if (isForm) {
        bodyStr = body;
        reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        bodyStr = JSON.stringify(body);
        reqHeaders['Content-Type'] = 'application/json';
      }
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
  if (p.url) return p.url;
  return null;
}

function richText(text) {
  if (!text) return { rich_text: [] };
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) {
    chunks.push({ type: 'text', text: { content: text.substring(i, i + 1900) } });
  }
  return { rich_text: chunks };
}

function urlProp(url) {
  return { url: url || null };
}

// === CLAUDE ===
async function claude(prompt, maxTokens, model) {
  const result = await apiRequest(
    'api.anthropic.com', '/v1/messages', 'POST',
    { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    { model: model || 'claude-sonnet-4-20250514', max_tokens: maxTokens || 2000, messages: [{ role: 'user', content: prompt }] }
  );
  if (!result.content) throw new Error('Claude error: ' + JSON.stringify(result).substring(0, 300));
  return result.content.map(c => c.text || '').join('').trim();
}

// === OPENAI: DALL-E ===
async function generateImage(prompt) {
  if (!OPENAI_API_KEY) return null;
  const result = await apiRequest(
    'api.openai.com', '/v1/images/generations', 'POST',
    { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
    {
      model: 'dall-e-3',
      prompt: prompt,
      n: 1,
      size: '1024x1024',
      quality: 'standard'
    }
  );
  if (!result.data || !result.data[0]) {
    throw new Error('OpenAI error: ' + JSON.stringify(result).substring(0, 300));
  }
  const item = result.data[0];
  if (item.url) return item.url;
  if (item.b64_json) return 'data:image/png;base64,' + item.b64_json;
  throw new Error('OpenAI вернул неожиданный формат');
}

// === CLOUDINARY: загрузка картинки по URL или data URI ===
async function uploadToCloudinary(imageUrl) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return imageUrl;
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(stringToSign).digest('hex');
  const body = `file=${encodeURIComponent(imageUrl)}&api_key=${CLOUDINARY_API_KEY}&timestamp=${timestamp}&signature=${signature}`;
  const result = await apiRequest(
    'api.cloudinary.com', `/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, 'POST',
    {}, body, true
  );
  if (!result.secure_url) {
    throw new Error('Cloudinary error: ' + JSON.stringify(result).substring(0, 300));
  }
  return result.secure_url;
}

// === TELEGRAM ===
async function notify(text, useMarkdown) {
  if (!TG_BOT_TOKEN || !TG_ADMIN_ID) return;
  const payload = { chat_id: TG_ADMIN_ID, text: text, disable_web_page_preview: true };
  if (useMarkdown !== false) payload.parse_mode = 'Markdown';
  const res = await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendMessage`, 'POST', {}, payload);
  if (res && res.ok === false && useMarkdown !== false) {
    delete payload.parse_mode;
    await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendMessage`, 'POST', {}, payload);
  }
}

async function notifyPhoto(imageUrl, caption) {
  if (!TG_BOT_TOKEN || !TG_ADMIN_ID || !imageUrl) return;
  const payload = { chat_id: TG_ADMIN_ID, photo: imageUrl, caption: caption || '', parse_mode: 'Markdown' };
  const res = await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendPhoto`, 'POST', {}, payload);
  if (res && res.ok === false) {
    delete payload.parse_mode;
    await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendPhoto`, 'POST', {}, payload);
  }
}

// === ОСНОВНАЯ ЛОГИКА ===
function today() {
  const now = new Date();
  const msk = new Date(now.getTime() + (3 * 60 - now.getTimezoneOffset()) * 60000);
  return msk.toISOString().substring(0, 10);
}

async function findTodayPlanned() {
  const result = await queryDatabase(CONTENT_PLAN_DB, {
    property: 'Дата', date: { equals: today() }
  });
  if (!result.results) throw new Error('Контент-план: ' + JSON.stringify(result).substring(0, 200));
  return result.results;
}

async function findPostByTitle(title) {
  const result = await queryDatabase(POSTS_DB, {
    property: 'Тема', title: { equals: title }
  });
  if (!result.results || result.results.length === 0) return null;
  return result.results[0];
}

async function processPost(planEntry) {
  const title = getProp(planEntry.properties, 'Пост');
  console.log('Обрабатываю:', title);
  if (!title) { console.log('У записи нет названия'); return null; }

  const post = await findPostByTitle(title);
  if (!post) {
    await notify(`Нет карточки в Постах: ${title}. Создай её вручную и запусти бот снова.`, false);
    return null;
  }

  const props = post.properties;
  let framework = getProp(props, 'Каркас (ChatGPT)') || getProp(props, 'Каркас');
  let tgText = getProp(props, 'TG-текст');
  let imageUrl = getProp(props, 'Картинка') || getProp(props, 'URL');

  const updates = {};
  const workDone = [];
  let finalImageUrl = imageUrl;

  // ШАГ 1: каркас
  if (!framework || framework.length < 100) {
    console.log('  → генерирую каркас...');
    framework = await claude(`${FRAMEWORK_PROMPT}\n\nТЕМА: ${title}`, 3000);
    const frameworkField = props['Каркас (ChatGPT)'] ? 'Каркас (ChatGPT)' : 'Каркас';
    updates[frameworkField] = richText(framework);
    workDone.push('каркас');
  }

  // ШАГ 2: упаковка
  if (!tgText || tgText.length < 100) {
    console.log('  → упаковываю в форматы...');
    const packed = await claude(`${PACKAGER_PROMPT}\n\nКАРКАС:\n${framework}`, 4000);
    const tgMatch = packed.match(/=== TELEGRAM ===\s*([\s\S]*?)(?:=== DZEN|===|$)/);
    const dzenMatch = packed.match(/=== DZEN ===\s*([\s\S]*?)(?:=== VK|===|$)/);
    const vkMatch = packed.match(/=== VK ===\s*([\s\S]*?)$/);
    if (tgMatch) updates['TG-текст'] = richText(tgMatch[1].trim());
    if (dzenMatch) updates['D
