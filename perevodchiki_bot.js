const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
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
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IMAGE_STYLE = process.env.IMAGE_STYLE || 'minimalist symbolic illustration, dark background, single strong metaphor, no text, cinematic light, christian psychology theme';
const VK_TOKEN = process.env.VK_TOKEN;
const VK_USER_TOKEN = process.env.VK_USER_TOKEN;
const VK_GROUP_ID = process.env.VK_GROUP_ID;
const VK_GROUP_IDS = (process.env.VK_GROUP_IDS || VK_GROUP_ID || '')
  .split(',')
  .map(id => id.trim().replace(/^-/, ''))
  .filter(Boolean);
const VK_ALBUM_ID = process.env.VK_ALBUM_ID;
const VK_API_VERSION = '5.199';

console.log('=== Переводчики сердца: бот запущен ===');
console.log('Время старта:', new Date().toISOString());
console.log('Генерация в', RUN_HOUR_MSK + ':00 МСК');
console.log('Модель картинок:', OPENAI_IMAGE_MODEL);
console.log('VK подключён:', !!VK_TOKEN && VK_GROUP_IDS.length > 0);
console.log('VK groups:', VK_GROUP_IDS.join(', ') || 'none');
console.log('VK User Token (для фоток):', !!VK_USER_TOKEN);

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
  if (typeof p.checkbox === 'boolean') return p.checkbox;
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

function urlProp(url) { return { url: url || null }; }
function checkboxProp(value) { return { checkbox: !!value }; }

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

// === OPENAI: генерация картинки ===
async function generateImage(prompt) {
  if (!OPENAI_API_KEY) return null;
  const body = { model: OPENAI_IMAGE_MODEL, prompt: prompt, n: 1, size: '1024x1024' };
  if (OPENAI_IMAGE_MODEL === 'dall-e-3') body.quality = 'standard';
  if (OPENAI_IMAGE_MODEL === 'gpt-image-1') body.quality = 'medium';
  const result = await apiRequest(
    'api.openai.com', '/v1/images/generations', 'POST',
    { 'Authorization': `Bearer ${OPENAI_API_KEY}` }, body
  );
  if (!result.data || !result.data[0]) throw new Error('OpenAI error: ' + JSON.stringify(result).substring(0, 400));
  const item = result.data[0];
  if (item.url) return item.url;
  if (item.b64_json) return 'data:image/png;base64,' + item.b64_json;
  throw new Error('OpenAI вернул неожиданный формат');
}

// === CLOUDINARY ===
async function uploadToCloudinary(imageUrl) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return imageUrl;
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(stringToSign).digest('hex');
  const body = `file=${encodeURIComponent(imageUrl)}&api_key=${CLOUDINARY_API_KEY}&timestamp=${timestamp}&signature=${signature}`;
  const result = await apiRequest('api.cloudinary.com', `/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, 'POST', {}, body, true);
  if (!result.secure_url) throw new Error('Cloudinary error: ' + JSON.stringify(result).substring(0, 300));
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

// === VK ПУБЛИКАЦИЯ ===
function downloadBuffer(urlString) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    https.get({ hostname: u.hostname, path: u.pathname + u.search }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function uploadMultipart(uploadUrlString, fieldName, filename, buffer, mimeType) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrlString);
    const boundary = '----PerevodchikiFormBoundary' + Date.now();
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([preamble, buffer, epilogue]);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve({ error: 'parse', raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function vkCall(method, params, useUserToken) {
  const token = useUserToken && VK_USER_TOKEN ? VK_USER_TOKEN : VK_TOKEN;
  const allParams = Object.assign({}, params, {
    access_token: token,
    v: VK_API_VERSION
  });
  const body = Object.entries(allParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const result = await apiRequest('api.vk.com', `/method/${method}`, 'POST', {}, body, true);
  if (result.error) throw new Error('VK error in ' + method + ': ' + JSON.stringify(result.error).substring(0, 300));
  return result.response;
}

function vkGroupForPost(index) {
  if (VK_GROUP_IDS.length === 0) return null;
  return VK_GROUP_IDS[index % VK_GROUP_IDS.length];
}

async function vkPublish(text, imageUrl, groupId) {
  if (!VK_TOKEN || !groupId) throw new Error('VK не настроен (нет VK_TOKEN или VK_GROUP_ID/VK_GROUP_IDS)');

  let attachment = null;
  let messageText = text || '';

  if (imageUrl) {
    if (VK_USER_TOKEN) {
      // Грузим фото на стену сообщества через User Token (правильный путь)
      try {
        console.log('    VK: получаю wall upload server для группы', groupId, '...');
        const uploadServer = await vkCall('photos.getWallUploadServer', {
          group_id: groupId
        }, true);
        console.log('    VK: скачиваю картинку с Cloudinary...');
        const imageBuffer = await downloadBuffer(imageUrl);
        console.log('    VK: загружаю фото (' + imageBuffer.length + ' байт)...');
        const uploaded = await uploadMultipart(uploadServer.upload_url, 'photo', 'image.jpg', imageBuffer, 'image/jpeg');
        if (uploaded.error) throw new Error('VK upload: ' + JSON.stringify(uploaded));
        console.log('    VK: сохраняю фото на стену...');
        const saved = await vkCall('photos.saveWallPhoto', {
          group_id: groupId,
          server: uploaded.server,
          photo: uploaded.photo,
          hash: uploaded.hash
        }, true);
        if (!saved || !saved[0]) throw new Error('VK photos.saveWallPhoto: пустой ответ');
        attachment = `photo${saved[0].owner_id}_${saved[0].id}`;
        console.log('    VK: attachment =', attachment);
      } catch (e) {
        console.error('    VK: не удалось загрузить картинку:', e.message);
        console.error('    VK: пощу без картинки, добавлю ссылку в конец');
        messageText += '\n\n' + imageUrl;
      }
    } else {
      // User Token не настроен — фоллбэк на URL в тексте
      console.log('    VK: VK_USER_TOKEN не задан, картинка идёт ссылкой в тексте');
      messageText += '\n\n' + imageUrl;
    }
  }

  console.log('    VK: публикую пост...');
  const params = {
    owner_id: '-' + groupId,
    from_group: 1,
    message: messageText
  };
  if (attachment) params.attachments = attachment;
  const posted = await vkCall('wall.post', params);
  const postId = posted.post_id;
  const postUrl = `https://vk.com/wall-${groupId}_${postId}`;
  return postUrl;
}

// === ОСНОВНАЯ ЛОГИКА ГЕНЕРАЦИИ ===
function today() {
  const now = new Date();
  const msk = new Date(now.getTime() + (3 * 60 - now.getTimezoneOffset()) * 60000);
  return msk.toISOString().substring(0, 10);
}

async function findTodayPlanned() {
  const todayStr = today();
  const result = await queryDatabase(POSTS_DB);
  if (!result.results) throw new Error('Посты: ' + JSON.stringify(result).substring(0, 200));
  // Фильтруем в памяти: статус=запланировано И дата=сегодня
  // (так избегаем проблем с типами столбцов Notion — status vs select)
  return result.results.filter(post => {
    const status = (getProp(post.properties, 'Статус') || '').toString().toLowerCase();
    const date = getProp(post.properties, 'Дата публикации');
    return status === 'запланировано' && date === todayStr;
  });
}

async function processPost(post) {
  const title = getProp(post.properties, 'Тема');
  console.log('Обрабатываю:', title);
  if (!title) { console.log('У поста нет названия (поле Тема)'); return null; }

  const props = post.properties;
  let framework = getProp(props, 'Каркас (ChatGPT)') || getProp(props, 'Каркас');
  let tgText = getProp(props, 'TG-текст');
  let imageUrl = getProp(props, 'Картинка') || getProp(props, 'URL');

  const updates = {};
  const workDone = [];
  let finalImageUrl = imageUrl;

  if (!framework || framework.length < 100) {
    console.log('  -> генерирую каркас...');
    framework = await claude(`${FRAMEWORK_PROMPT}\n\nТЕМА: ${title}`, 3000);
    const frameworkField = props['Каркас (ChatGPT)'] ? 'Каркас (ChatGPT)' : 'Каркас';
    updates[frameworkField] = richText(framework);
    workDone.push('каркас');
  }

  if (!tgText || tgText.length < 100) {
    console.log('  -> упаковываю в форматы...');
    const packed = await claude(`${PACKAGER_PROMPT}\n\nКАРКАС:\n${framework}`, 4000);
    console.log('  -> packed response preview:', packed.substring(0, 300));
    const tgMatch = packed.match(/=== TELEGRAM ===\s*([\s\S]*?)(?:=== DZEN|=== VK|=== INSTA|===|$)/);
    const dzenMatch = packed.match(/=== DZEN ===\s*([\s\S]*?)(?:=== VK|=== INSTA|===|$)/);
    const vkMatch = packed.match(/=== VK ===\s*([\s\S]*?)(?:=== INSTA|===|$)/);
    const instaMatch = packed.match(/=== INSTA ===\s*([\s\S]*?)$/);
    if (tgMatch) updates['TG-текст'] = richText(tgMatch[1].trim());
    if (dzenMatch) updates['Dzen-текст'] = richText(dzenMatch[1].trim());
    if (vkMatch) updates['VK-текст'] = richText(vkMatch[1].trim());
    if (instaMatch && props['Insta-карусель']) updates['Insta-карусель'] = richText(instaMatch[1].trim());
    workDone.push('тексты');
  }

  if (!imageUrl && OPENAI_API_KEY) {
    try {
      console.log('  -> генерирую промпт для картинки...');
      const imagePrompt = await claude(
        `На основе библейско-психологической темы "${title}" составь КОРОТКИЙ английский промпт для генерации картинки (1-2 предложения, максимум 60 слов). Стиль: ${IMAGE_STYLE}. Без текста и надписей на картинке. Только сильный визуальный образ-метафора. Верни ТОЛЬКО сам промпт, без объяснений.`,
        300, 'claude-haiku-4-5-20251001'
      );
      console.log('  -> промпт:', imagePrompt);
      console.log('  -> генерирую картинку через', OPENAI_IMAGE_MODEL, '...');
      const rawUrl = await generateImage(imagePrompt);
      console.log('  -> загружаю в Cloudinary...');
      finalImageUrl = await uploadToCloudinary(rawUrl);
      const imageField = props['Картинка'] ? 'Картинка' : (props['URL'] ? 'URL' : null);
      if (imageField) updates[imageField] = urlProp(finalImageUrl);
      workDone.push('картинка');
    } catch (e) {
      console.error('  -> ошибка картинки:', e.message);
      await notify(`Не удалось сгенерировать картинку для "${title}": ${e.message}`, false);
    }
  }

  if (Object.keys(updates).length > 0) {
    await updatePage(post.id, updates);
    await updatePage(post.id, { 'Статус': { select: { name: 'утверждено' } } });
    const postUrl = `https://www.notion.so/${post.id.replace(/-/g, '')}`;
    const message = `✅ *${title}*\n\nСгенерировал: ${workDone.join(', ')}\n\n[Открыть в Notion](${postUrl})`;
    if (finalImageUrl && workDone.includes('картинка')) await notifyPhoto(finalImageUrl, message);
    else await notify(message);
    return title;
  }
  console.log('  -> уже всё готово');
  return null;
}

async function runDaily() {
  console.log('\n=== Цикл генерации:', new Date().toISOString(), '===');
  try {
    const planned = await findTodayPlanned();
    console.log('На сегодня запланировано:', planned.length);
    if (planned.length === 0) return;
    for (const entry of planned) {
      try { await processPost(entry); }
      catch (e) {
        console.error('Ошибка обработки:', e.message);
        await notify(`Ошибка обработки поста: ${e.message}`, false);
      }
    }
  } catch (e) {
    console.error('Ошибка цикла генерации:', e.message);
    await notify(`Ошибка цикла генерации: ${e.message}`, false);
  }
}

// === ЦИКЛ ПУБЛИКАЦИИ В VK ===
async function findApprovedForVK() {
  const result = await queryDatabase(POSTS_DB);
  if (!result.results) throw new Error('Posts: ' + JSON.stringify(result).substring(0, 200));
  return result.results.filter(post => {
    const status = (getProp(post.properties, 'Статус') || '').toString();
    const vkPublished = !!(post.properties['VK'] && post.properties['VK'].checkbox);
    const hasText = !!getProp(post.properties, 'VK-текст');
    return (status.toLowerCase() === 'утверждено') && !vkPublished && hasText;
  });
}

async function publishVKCycle() {
  if (!VK_TOKEN || VK_GROUP_IDS.length === 0) return;
  console.log('\n=== Цикл публикации VK:', new Date().toISOString(), '===');
  try {
    const approved = await findApprovedForVK();
    console.log('Утверждено для публикации в VK:', approved.length);
    for (let i = 0; i < approved.length; i++) {
      const post = approved[i];
      const title = getProp(post.properties, 'Тема');
      try {
        const vkText = getProp(post.properties, 'VK-текст');
        const imageUrl = getProp(post.properties, 'Картинка') || getProp(post.properties, 'URL');
        const groupId = vkGroupForPost(i);
        console.log('Публикую в VK:', title, 'group:', groupId);
        const vkPostUrl = await vkPublish(vkText, imageUrl, groupId);
        await updatePage(post.id, { 'VK': checkboxProp(true) });
        await notify(`✅ Опубликовано в VK: *${title}*\n\n[Посмотреть пост](${vkPostUrl})`);
        console.log('Опубликовано:', vkPostUrl);
      } catch (e) {
        console.error('Ошибка публикации VK:', e.message);
        await notify(`Ошибка публикации в VK "${title}": ${e.message}`, false);
      }
    }
  } catch (e) {
    console.error('Ошибка цикла VK:', e.message);
  }
}

// === ПЛАНИРОВЩИК ===
let lastRunDate = null;

// -- TG ————————————————————————————————————————————————
async function findApprovedForTG() {
  const filter = {
    and: [
      { property: 'Dzen', checkbox: { equals: true } },
      { property: 'TG готов', checkbox: { equals: false } }
    ]
  };
  const result = await queryDatabase(POSTS_DB, filter);
  if (!result.results) throw new Error('Posts: ' + JSON.stringify(result).substring(0, 200));
  console.log('TG (Dzen-пакет) кандидатов:', result.results.length);
  return result.results.filter(post => {
    const hasDzenText = post.properties['Dzen-текст']?.rich_text?.length > 0;
    return hasDzenText;
  });
}

async function publishTGCycle() {
  console.log('\n=== Цикл публикации TG (Дзен-пакет): ' + new Date().toISOString() + ' ===');
  try {
    const approved = await findApprovedForTG();
    console.log('Утверждено для TG-доставки:', approved.length);
    for (const post of approved) {
      const title = getProp(post.properties, 'Тема');
      try {
        const dzenText = getProp(post.properties, 'Dzen-текст');
        const imageUrl = getProp(post.properties, 'Картинка') || getProp(post.properties, 'URL');
        console.log('Отправляю пакет в TG для Дзена:', title);
        if (imageUrl) {
          await notifyPhoto(imageUrl, `📚 Пакет для Дзена: ${title}`);
        }
        await notify(`📚 Дзен-публикация: ${title}\n\n${dzenText}`, true);
        await updatePage(post.id, { 'TG готов': checkboxProp(true) });
        console.log('Пакет для Дзена отправлен в TG:', title);
      } catch (e) {
        console.error('Ошибка отправки TG-пакета:', title, e.message);
        await notify('Ошибка TG-пакета: ' + title + ': ' + e.message, false);
      }
    }
  } catch (e) {
    console.error('Ошибка цикла TG:', e.message);
  }
}

function checkAndRun() {
  const now = new Date();
  const msk = new Date(now.getTime() + (3 * 60 - now.getTimezoneOffset()) * 60000);
  const currentHour = msk.getUTCHours();
  const dateKey = msk.toISOString().substring(0, 10);
  if (currentHour === RUN_HOUR_MSK && lastRunDate !== dateKey) {
    lastRunDate = dateKey;
    console.log('Запуск ежедневной генерации, МСК:', msk.toISOString());
    runDaily();
  }
}
setInterval(checkAndRun, 5 * 60 * 1000);
setInterval(publishVKCycle, 60 * 60 * 1000); // публикация раз в час
setInterval(publishTGCycle, 60 * 60 * 1000);
publishTGCycle();
checkAndRun();
publishVKCycle(); // и сразу при старте

// === SEED ENDPOINT (одноразовое создание тем в Notion) ===
const SEED_KEY = process.env.SEED_KEY;
const THEMES_TO_SEED = [
  { title: 'Переводчик одиночества', date: '2026-05-27' },
  { title: 'Переводчик гнева', date: '2026-05-28' },
  { title: 'Переводчик вины', date: '2026-05-29' },
  { title: 'Переводчик обиды', date: '2026-05-30' },
  { title: 'Переводчик зависти', date: '2026-05-31' },
  { title: 'Переводчик тревоги', date: '2026-06-01' },
  { title: 'Переводчик контроля', date: '2026-06-02' },
  { title: 'Переводчик перфекционизма', date: '2026-06-03' },
  { title: 'Переводчик сравнения', date: '2026-06-04' },
  { title: 'Переводчик отвержения', date: '2026-06-05' },
  { title: 'Переводчик жертвы', date: '2026-06-06' },
  { title: 'Переводчик спасателя', date: '2026-06-07' },
  { title: 'Переводчик самозванца', date: '2026-06-08' },
  { title: 'Переводчик прокрастинации', date: '2026-06-09' },
  { title: 'Переводчик идеализации', date: '2026-06-10' },
  { title: 'Переводчик обесценивания', date: '2026-06-11' },
  { title: 'Переводчик оправдания', date: '2026-06-12' },
  { title: 'Переводчик подозрений', date: '2026-06-13' },
  { title: 'Переводчик выгорания', date: '2026-06-14' },
  { title: 'Переводчик гордыни', date: '2026-06-15' },
  { title: 'Переводчик гиперответственности', date: '2026-06-16' },
  { title: 'Переводчик бессмыслицы', date: '2026-06-17' },
  { title: 'Переводчик пустоты', date: '2026-06-18' },
  { title: 'Переводчик травмы', date: '2026-06-19' },
  { title: 'Переводчик мечтательности', date: '2026-06-20' },
  { title: 'Переводчик ревности', date: '2026-06-21' },
  { title: 'Переводчик жалости к себе', date: '2026-06-22' },
  { title: 'Переводчик апатии', date: '2026-06-23' }
];

async function seedThemes() {
  // Читаем схему чтобы понять тип столбцов Статус и Серия
  const schema = await apiRequest('api.notion.com', `/v1/databases/${POSTS_DB}`, 'GET', NOTION_HEADERS);
  if (!schema.properties) throw new Error('Не удалось прочитать схему: ' + JSON.stringify(schema).substring(0, 300));
  const statusType = schema.properties['Статус'] ? schema.properties['Статус'].type : null;
  const seriesType = schema.properties['Серия'] ? schema.properties['Серия'].type : null;

  const results = [];
  for (const t of THEMES_TO_SEED) {
    const properties = {
      'Тема': { title: [{ text: { content: t.title } }] },
      'Дата публикации': { date: { start: t.date } }
    };
    if (seriesType === 'select') properties['Серия'] = { select: { name: 'Переводчики сердца' } };
    else if (seriesType === 'multi_select') properties['Серия'] = { multi_select: [{ name: 'Переводчики сердца' }] };
    if (statusType === 'status') properties['Статус'] = { status: { name: 'запланировано' } };
    else if (statusType === 'select') properties['Статус'] = { select: { name: 'запланировано' } };

    const r = await apiRequest('api.notion.com', '/v1/pages', 'POST', NOTION_HEADERS, {
      parent: { database_id: POSTS_DB },
      properties
    });
    if (r.id) results.push(`OK  ${t.title}  (${t.date})`);
    else results.push(`FAIL ${t.title} — ${JSON.stringify(r).substring(0, 200)}`);
    await new Promise(r => setTimeout(r, 350));
  }
  return { statusType, seriesType, results };
}

// === ОДНОРАЗОВЫЙ ПОСЕВ ПРИ СТАРТЕ (если SEED_NOW=true) ===
if (process.env.SEED_NOW === 'true') {
  console.log('\n🌱 SEED_NOW=true обнаружен — запускаю одноразовый посев тем в Notion...');
  seedThemes()
    .then(out => {
      console.log('✅ Посев завершён.');
      console.log('   Тип Статуса:', out.statusType);
      console.log('   Тип Серии:', out.seriesType);
      out.results.forEach(line => console.log('   ' + line));
      console.log('\n🌱 ВАЖНО: удали переменную SEED_NOW из Railway Variables, иначе посев повторится при каждом рестарте!\n');
      notify(`✅ Посев Notion завершён.\nСоздано: ${out.results.filter(r => r.startsWith('OK')).length} из ${out.results.length}.\n\nНе забудь удалить переменную SEED_NOW из Railway!`, false);
    })
    .catch(e => {
      console.error('❌ Ошибка посева:', e.message);
      notify(`Ошибка посева: ${e.message}`, false);
    });
}

// === HEALTHCHECK + SEED ENDPOINT ===
const server = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith('/seed')) {
    const url = new URL(req.url, 'http://localhost');
    const key = url.searchParams.get('key');
    if (!SEED_KEY || key !== SEED_KEY) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden. Нужен правильный ?key=...');
      return;
    }
    try {
      const out = await seedThemes();
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Готово.\nТип Статуса: ${out.statusType}\nТип Серии: ${out.seriesType}\n\n` + out.results.join('\n'));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ошибка: ' + e.message);
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Perevodchiki bot is alive.\nGen at ${RUN_HOUR_MSK}:00 MSK\nImage: ${OPENAI_IMAGE_MODEL}\nVK: ${!!VK_TOKEN && VK_GROUP_IDS.length > 0 ? 'on' : 'off'}\nVK groups: ${VK_GROUP_IDS.join(', ') || 'none'}\n`);
});

// Защита: если порт занят (двойной запуск модуля), не валим весь процесс
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('⚠️  Порт уже занят (EADDRINUSE). HTTP-сервер не поднялся.');
    console.error('⚠️  Бот продолжает работу — циклы генерации и публикации активны.');
    console.error('⚠️  Healthcheck и /seed недоступны до перезапуска.');
    return;
  }
  console.error('Ошибка HTTP-сервера:', err.message);
});

server.listen(process.env.PORT || 3000, () => {
  console.log('HTTP-сервер слушает порт', process.env.PORT || 3000);
});

if (process.env.FORCE_RUN === '1') { runDaily(); }
