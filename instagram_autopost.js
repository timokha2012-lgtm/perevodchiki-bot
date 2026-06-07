const https = require('https');
const crypto = require('crypto');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const POSTS_DB = process.env.POSTS_DATABASE_ID;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_ADMIN_ID = process.env.TG_ADMIN_ID;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const IG_API_VERSION = process.env.IG_API_VERSION || 'v24.0';
const INSTAGRAM_INTERVAL_MINUTES = parseInt(process.env.INSTAGRAM_INTERVAL_MINUTES || '60', 10);

const NOTION_HEADERS = {
  Authorization: `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28'
};

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

async function notify(text, useMarkdown) {
  if (!TG_BOT_TOKEN || !TG_ADMIN_ID) return;
  const payload = { chat_id: TG_ADMIN_ID, text, disable_web_page_preview: true };
  if (useMarkdown !== false) payload.parse_mode = 'Markdown';
  const res = await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendMessage`, 'POST', {}, payload);
  if (res && res.ok === false && useMarkdown !== false) {
    delete payload.parse_mode;
    await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendMessage`, 'POST', {}, payload);
  }
}

async function queryDatabase(dbId, filter) {
  const body = { page_size: 100 };
  if (filter) body.filter = filter;
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

function checkboxProp(value) { return { checkbox: !!value }; }
function urlProp(url) { return { url: url || null }; }

function cleanText(text) {
  return (text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\\\\|/g, '|')
    .replace(/\\\*/g, '*')
    .replace(/\r/g, '')
    .trim();
}

function parseCarousel(rawText, title) {
  const text = cleanText(rawText);
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const slides = [];
  let captionLines = [];
  let current = null;
  let inCaption = false;

  for (const line of lines) {
    if (/подпись|caption/i.test(line) && /карусел/i.test(line)) {
      inCaption = true;
      continue;
    }

    const slideMatch = line.match(/^(?:\*+)?\s*(?:slide|слайд)\s*(\d+)\s*(?:\([^)]*\))?\s*:?\s*(.*)$/i);
    if (slideMatch && !inCaption) {
      if (current) slides.push(current);
      current = { number: Number(slideMatch[1]), text: slideMatch[2].trim() };
      continue;
    }

    if (inCaption) {
      captionLines.push(line);
    } else if (current) {
      current.text += (current.text ? '\n' : '') + line;
    }
  }

  if (current) slides.push(current);

  let slideTexts = slides
    .sort((a, b) => a.number - b.number)
    .map(s => s.text.replace(/\*+/g, '').trim())
    .filter(Boolean)
    .slice(0, 10);

  if (slideTexts.length < 2) {
    slideTexts = chunkText(text.replace(/\*+/g, ''), 230).slice(0, 10);
  }

  if (slideTexts.length === 1) {
    slideTexts.push('Записаться на консультацию: @petrov.reab');
  }

  const caption = (captionLines.join('\n\n') || `${title}\n\nЗаписаться на консультацию: @petrov.reab`).slice(0, 2200);
  return { slides: slideTexts, caption };
}

function chunkText(text, maxLength) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxLength) {
      if (current) chunks.push(current);
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text, maxChars) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = (line + ' ' + word).trim();
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 9);
}

function makeSlideSvg(text, index, total, title) {
  const lines = wrapText(text, 24);
  const fontSize = lines.length > 6 ? 50 : 60;
  const lineHeight = Math.round(fontSize * 1.22);
  const yStart = 540 - ((lines.length - 1) * lineHeight) / 2;
  const textSpans = lines.map((line, i) =>
    `<text x="90" y="${yStart + i * lineHeight}" font-size="${fontSize}" font-weight="700" fill="#f7f1e7">${escapeXml(line)}</text>`
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
  <rect width="1080" height="1080" fill="#182028"/>
  <rect x="44" y="44" width="992" height="992" rx="34" fill="none" stroke="#d7b46a" stroke-width="4"/>
  <circle cx="920" cy="160" r="86" fill="#2f5d62" opacity="0.7"/>
  <circle cx="160" cy="900" r="120" fill="#8b3a3a" opacity="0.55"/>
  <text x="90" y="130" font-size="30" fill="#d7b46a" font-family="Arial, sans-serif">ПЕРЕВОДЧИКИ СЕРДЦА</text>
  <text x="90" y="188" font-size="26" fill="#9fb1bb" font-family="Arial, sans-serif">${escapeXml(title).slice(0, 58)}</text>
  <g font-family="Arial, sans-serif">${textSpans}</g>
  <text x="90" y="980" font-size="28" fill="#d7b46a" font-family="Arial, sans-serif">@petrov.reab</text>
  <text x="980" y="980" text-anchor="end" font-size="28" fill="#9fb1bb" font-family="Arial, sans-serif">${index + 1}/${total}</text>
</svg>`;
}

async function uploadToCloudinary(imageDataUri) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Для Instagram нужны CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY и CLOUDINARY_API_SECRET');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(stringToSign).digest('hex');
  const body = `file=${encodeURIComponent(imageDataUri)}&api_key=${CLOUDINARY_API_KEY}&timestamp=${timestamp}&signature=${signature}`;
  const result = await apiRequest('api.cloudinary.com', `/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, 'POST', {}, body, true);
  if (!result.secure_url) throw new Error('Cloudinary error: ' + JSON.stringify(result).substring(0, 300));
  return result.secure_url.replace('/upload/', '/upload/f_jpg,w_1080,h_1080,c_fill/');
}

async function createInstagramMedia(params) {
  const body = Object.entries(Object.assign({}, params, { access_token: IG_ACCESS_TOKEN }))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const result = await apiRequest('graph.facebook.com', `/${IG_API_VERSION}/${IG_USER_ID}/media`, 'POST', {}, body, true);
  if (!result.id) throw new Error('Instagram media error: ' + JSON.stringify(result).substring(0, 400));
  return result.id;
}

async function publishInstagramContainer(creationId) {
  const body = `creation_id=${encodeURIComponent(creationId)}&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`;
  const result = await apiRequest('graph.facebook.com', `/${IG_API_VERSION}/${IG_USER_ID}/media_publish`, 'POST', {}, body, true);
  if (!result.id) throw new Error('Instagram publish error: ' + JSON.stringify(result).substring(0, 400));
  return result.id;
}

async function getInstagramPermalink(mediaId) {
  const result = await apiRequest(
    'graph.facebook.com',
    `/${IG_API_VERSION}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`,
    'GET',
    {}
  );
  return result.permalink || null;
}

async function publishCarousel(title, carouselText) {
  if (!IG_ACCESS_TOKEN || !IG_USER_ID) {
    throw new Error('Для автопостинга Instagram нужны IG_ACCESS_TOKEN и IG_USER_ID');
  }

  const { slides, caption } = parseCarousel(carouselText, title);
  const imageUrls = [];
  for (let i = 0; i < slides.length; i += 1) {
    const svg = makeSlideSvg(slides[i], i, slides.length, title);
    const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    imageUrls.push(await uploadToCloudinary(dataUri));
  }

  const childIds = [];
  for (const imageUrl of imageUrls) {
    childIds.push(await createInstagramMedia({ image_url: imageUrl, is_carousel_item: 'true' }));
  }

  const containerId = await createInstagramMedia({
    media_type: 'CAROUSEL',
    children: childIds.join(','),
    caption
  });
  const publishedId = await publishInstagramContainer(containerId);
  const permalink = await getInstagramPermalink(publishedId);
  return { publishedId, permalink, slideCount: slides.length };
}

async function findApprovedForInstagram() {
  const filter = {
    and: [
      { property: 'Instagram', checkbox: { equals: false } },
      { property: 'Статус', select: { equals: 'утверждено' } },
      { property: 'Insta-карусель', rich_text: { is_not_empty: true } }
    ]
  };
  const result = await queryDatabase(POSTS_DB, filter);
  if (!result.results) throw new Error('Posts: ' + JSON.stringify(result).substring(0, 200));
  return result.results;
}

async function publishInstagramCycle() {
  if (!IG_ACCESS_TOKEN || !IG_USER_ID) return;
  console.log('\n=== Цикл публикации Instagram:', new Date().toISOString(), '===');
  try {
    const approved = await findApprovedForInstagram();
    console.log('Готово для Instagram:', approved.length);
    for (const post of approved) {
      const title = getProp(post.properties, 'Тема');
      try {
        const carouselText = getProp(post.properties, 'Insta-карусель');
        console.log('Публикую Instagram-карусель:', title);
        const published = await publishCarousel(title, carouselText);
        await updatePage(post.id, {
          Instagram: checkboxProp(true),
          'Instagram URL': urlProp(published.permalink)
        });
        await notify(`✅ Опубликовано в Instagram: *${title}*\nСлайдов: ${published.slideCount}\n\n${published.permalink || published.publishedId}`);
      } catch (e) {
        console.error('Ошибка Instagram:', title, e.message);
        await notify(`Ошибка Instagram "${title}": ${e.message}`, false);
      }
    }
  } catch (e) {
    console.error('Ошибка цикла Instagram:', e.message);
  }
}

setInterval(publishInstagramCycle, INSTAGRAM_INTERVAL_MINUTES * 60 * 1000);
publishInstagramCycle();
