const https = require('https');
const crypto = require('crypto');

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const POSTS_DB = process.env.POSTS_DATABASE_ID;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_ADMIN_ID = process.env.TG_ADMIN_ID;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
const INSTAGRAM_INTERVAL_MINUTES = parseInt(process.env.INSTAGRAM_INTERVAL_MINUTES || '60', 10);
const INSTAGRAM_AI_BACKGROUNDS = String(process.env.INSTAGRAM_AI_BACKGROUNDS || 'true').toLowerCase() !== 'false';

const SLIDE_WIDTH = 1080;
const SLIDE_HEIGHT = 1350;
const HANDLE = '@petrov.reab';

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

async function notifyPhoto(imageUrl, caption) {
  if (!TG_BOT_TOKEN || !TG_ADMIN_ID || !imageUrl) return;
  const payload = { chat_id: TG_ADMIN_ID, photo: imageUrl, caption: caption || '' };
  const res = await apiRequest('api.telegram.org', `/bot${TG_BOT_TOKEN}/sendPhoto`, 'POST', {}, payload);
  if (res && res.ok === false) {
    await notify(`${caption || 'Instagram slide'}\n${imageUrl}`, false);
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
  const captionLines = [];
  let current = null;
  let inCaption = false;

  for (const line of lines) {
    if (/^(?:\*+)?\s*(?:подпись|caption)\b/i.test(line)) {
      inCaption = true;
      const afterColon = line.split(':').slice(1).join(':').trim();
      if (afterColon) captionLines.push(afterColon);
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
    .filter(Boolean);

  if (slideTexts.length < 2) {
    slideTexts = chunkText(text.replace(/\*+/g, ''), 190);
  }

  slideTexts = slideTexts.slice(0, 7);
  while (slideTexts.length < 7) {
    const fallback = [
      title || 'Путь начинается с честности.',
      'Назови то, что происходит внутри. Без приговора себе.',
      'Стыд закрывает. Совесть показывает направление.',
      'Один честный шаг сильнее бесконечных обещаний.',
      'Не оставайся с этим один.',
      'Выход начинается с разговора.',
      `Сохрани эту карусель. Записаться: ${HANDLE}`
    ];
    slideTexts.push(fallback[slideTexts.length]);
  }

  const caption = (captionLines.join('\n\n') || `${title}\n\nЕсли откликается, напиши в директ: ${HANDLE}`).slice(0, 2200);
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

function escapeAttr(text) {
  return escapeXml(text).replace(/\n/g, ' ');
}

function normalizeSlideText(text) {
  return String(text || '')
    .replace(/\s*[-—]\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitHeadlineBody(text) {
  const cleaned = normalizeSlideText(text);
  const sentences = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 1 && sentences[0].length <= 72) {
    return { headline: sentences[0], body: sentences.slice(1).join(' ') };
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length <= 12) return { headline: cleaned, body: '' };
  const headline = words.slice(0, Math.min(10, Math.ceil(words.length * 0.38))).join(' ');
  const body = words.slice(headline.split(/\s+/).length).join(' ');
  return { headline, body };
}

function wrapText(text, maxChars, maxLines) {
  const words = normalizeSlideText(text).split(/\s+/).filter(Boolean);
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
  return lines.slice(0, maxLines);
}

function fallbackBackground(index) {
  const themes = [
    ['#0d1014', '#38414a', '#14171c'],
    ['#101010', '#3a3a3a', '#191919'],
    ['#0c1112', '#344145', '#111718'],
    ['#111015', '#3d3338', '#17151b'],
    ['#0b0d0f', '#35393c', '#131619'],
    ['#101210', '#403a2f', '#161713'],
    ['#0d0d0d', '#2f2f2f', '#121212']
  ];
  const [a, b, c] = themes[index % themes.length];
  const object = [
    '<ellipse cx="790" cy="1010" rx="245" ry="64" fill="#111" opacity=".55"/><rect x="650" y="735" width="260" height="350" rx="6" fill="#20262c" opacity=".82" transform="rotate(-7 780 910)"/><rect x="682" y="774" width="196" height="256" fill="#0a0b0d" opacity=".75" transform="rotate(-7 780 910)"/>',
    '<path d="M760 390 h210 v610 h-210 z" fill="#2b211b" opacity=".82"/><path d="M760 390 c-80 120-72 478 0 610" fill="#111" opacity=".72"/><path d="M758 610 h212" stroke="#c49a63" stroke-width="10" opacity=".55"/>',
    '<path d="M610 910 c120-150 280-150 392 0" fill="none" stroke="#51463b" stroke-width="54" stroke-linecap="round" opacity=".78"/><path d="M690 925 c80-86 170-86 246 0" fill="none" stroke="#85715a" stroke-width="36" stroke-linecap="round" opacity=".7"/>',
    '<path d="M440 1050 C610 820 780 760 1040 650" fill="none" stroke="#d9d1bd" stroke-width="28" opacity=".36"/><path d="M450 1050 C630 840 792 782 1040 680" fill="none" stroke="#221f1b" stroke-width="70" opacity=".52"/>',
    '<path d="M675 980 l255-210" stroke="#786754" stroke-width="40" opacity=".78"/><path d="M900 730 l85 112 l-130 20 z" fill="#786754" opacity=".78"/>',
    '<rect x="610" y="760" width="320" height="240" rx="10" fill="#d5bc8a" opacity=".58" transform="skewY(-7)"/><path d="M600 800 c140 50 240 50 365 0" fill="none" stroke="#f1dca8" stroke-width="18" opacity=".58"/>',
    '<rect x="770" y="95" width="132" height="132" rx="66" fill="#f3f3f3" opacity=".82"/><circle cx="836" cy="161" r="56" fill="#0b0b0b" opacity=".8"/>'
  ][index % 7];

  return `<defs>
    <radialGradient id="g${index}" cx="20%" cy="10%" r="90%">
      <stop offset="0%" stop-color="${b}"/>
      <stop offset="46%" stop-color="${a}"/>
      <stop offset="100%" stop-color="${c}"/>
    </radialGradient>
    <filter id="grain${index}">
      <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
      <feComponentTransfer><feFuncA type="table" tableValues="0 0.13"/></feComponentTransfer>
    </filter>
  </defs>
  <rect width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" fill="url(#g${index})"/>
  <rect width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" filter="url(#grain${index})" opacity=".35"/>
  ${object}`;
}

function makeSlideSvg(text, index, total, title, backgroundUrl) {
  const { headline, body } = splitHeadlineBody(text);
  const headlineLines = wrapText(headline, 17, 4);
  const bodyLines = wrapText(body, 25, 8);
  const headlineSize = headlineLines.length > 3 ? 68 : headlineLines.length > 2 ? 76 : 88;
  const bodySize = bodyLines.length > 5 ? 48 : 54;
  const headlineHeight = Math.round(headlineSize * 1.12);
  const bodyHeight = Math.round(bodySize * 1.18);
  const headlineSpans = headlineLines.map((line, i) =>
    `<text x="92" y="${260 + i * headlineHeight}" font-size="${headlineSize}" font-weight="800" fill="#f7f4ee">${escapeXml(line)}</text>`
  ).join('');
  const bodyY = 260 + headlineLines.length * headlineHeight + 72;
  const bodySpans = bodyLines.map((line, i) =>
    `<text x="92" y="${bodyY + i * bodyHeight}" font-size="${bodySize}" font-weight="400" fill="#d8d6d0">${escapeXml(line)}</text>`
  ).join('');
  const bg = backgroundUrl
    ? `<image href="${escapeAttr(backgroundUrl)}" x="0" y="0" width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" preserveAspectRatio="xMidYMid slice"/>`
    : fallbackBackground(index);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" viewBox="0 0 ${SLIDE_WIDTH} ${SLIDE_HEIGHT}">
  ${bg}
  <rect width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" fill="#000" opacity=".58"/>
  <linearGradient id="shade" x1="0" x2="1" y1="0" y2="1">
    <stop offset="0%" stop-color="#000" stop-opacity=".42"/>
    <stop offset="52%" stop-color="#000" stop-opacity=".08"/>
    <stop offset="100%" stop-color="#000" stop-opacity=".56"/>
  </linearGradient>
  <rect width="${SLIDE_WIDTH}" height="${SLIDE_HEIGHT}" fill="url(#shade)"/>
  <g font-family="Arial, Helvetica, sans-serif" letter-spacing="0">
    <text x="990" y="96" text-anchor="end" font-size="34" fill="#d8d6d0" opacity=".58">${index + 1}/${total}</text>
    ${headlineSpans}
    ${bodySpans}
    <text x="92" y="1264" font-size="36" fill="#d8d6d0" opacity=".48">${HANDLE}</text>
    <text x="92" y="112" font-size="28" font-weight="700" fill="#d8d6d0" opacity=".58">${escapeXml(title || 'Переводчики сердца').slice(0, 54)}</text>
  </g>
</svg>`;
}

function buildBackgroundPrompt(slideText, index, title) {
  const metaphors = [
    'a dim mirror with a blurred human silhouette',
    'a person sitting alone in a dark room near a wall',
    'an old wooden signpost on a foggy road',
    'a narrow road disappearing into mist with a faint light ahead',
    'a broken chain lying on a dark floor',
    'an old door slightly open with warm light through the gap',
    'an open notebook on a wooden table under a single soft lamp'
  ];
  return [
    'Cinematic vertical editorial photograph for a psychology and faith Instagram carousel.',
    `Topic: ${title || 'inner recovery'}. Slide idea: ${slideText}.`,
    `Visual metaphor: ${metaphors[index % metaphors.length]}.`,
    'Dark moody atmosphere, realistic photo, soft directional light, shallow depth of field, premium magazine style.',
    'Leave large empty dark space on the left/top for Russian text overlay. No letters, no words, no logos, no watermark, no hands with readable tattoos.'
  ].join(' ');
}

async function generateBackgroundImage(slideText, index, title) {
  if (!OPENAI_API_KEY || !INSTAGRAM_AI_BACKGROUNDS) return null;
  const result = await apiRequest(
    'api.openai.com',
    '/v1/images/generations',
    'POST',
    { Authorization: `Bearer ${OPENAI_API_KEY}` },
    {
      model: OPENAI_IMAGE_MODEL,
      prompt: buildBackgroundPrompt(slideText, index, title),
      n: 1,
      size: OPENAI_IMAGE_SIZE
    }
  );
  const item = result && result.data && result.data[0];
  if (!item) throw new Error('OpenAI image error: ' + JSON.stringify(result).substring(0, 300));
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item.url) return item.url;
  throw new Error('OpenAI image response without image: ' + JSON.stringify(result).substring(0, 300));
}

async function uploadToCloudinary(imageDataUri, width, height) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error('Для Instagram-пакета нужны CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY и CLOUDINARY_API_SECRET');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const stringToSign = `timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(stringToSign).digest('hex');
  const body = `file=${encodeURIComponent(imageDataUri)}&api_key=${CLOUDINARY_API_KEY}&timestamp=${timestamp}&signature=${signature}`;
  const result = await apiRequest('api.cloudinary.com', `/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, 'POST', {}, body, true);
  if (!result.secure_url) throw new Error('Cloudinary error: ' + JSON.stringify(result).substring(0, 300));
  return result.secure_url.replace('/upload/', `/upload/f_jpg,w_${width},h_${height},c_fill,q_auto:good/`);
}

async function makeCarouselImages(title, carouselText) {
  const { slides, caption } = parseCarousel(carouselText, title);
  const imageUrls = [];
  for (let i = 0; i < slides.length; i += 1) {
    let backgroundUrl = null;
    try {
      const bgImage = await generateBackgroundImage(slides[i], i, title);
      if (bgImage) backgroundUrl = await uploadToCloudinary(bgImage, SLIDE_WIDTH, SLIDE_HEIGHT);
    } catch (e) {
      console.warn('Фон OpenAI не создан, использую встроенный фон:', e.message);
    }
    const svg = makeSlideSvg(slides[i], i, slides.length, title, backgroundUrl);
    const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    imageUrls.push(await uploadToCloudinary(dataUri, SLIDE_WIDTH, SLIDE_HEIGHT));
  }
  return { imageUrls, caption };
}

async function findInstagramPackagesForTG() {
  const filter = {
    and: [
      { property: 'Instagram', checkbox: { equals: false } },
      { property: 'Instagram в TG', checkbox: { equals: false } },
      { property: 'Статус', select: { equals: 'утверждено' } },
      { property: 'Insta-карусель', rich_text: { is_not_empty: true } }
    ]
  };
  const result = await queryDatabase(POSTS_DB, filter);
  if (!result.results) throw new Error('Posts: ' + JSON.stringify(result).substring(0, 200));
  return result.results;
}

async function sendInstagramPackageCycle() {
  console.log('\n=== Цикл подготовки Instagram-пакета в TG:', new Date().toISOString(), '===');
  try {
    const posts = await findInstagramPackagesForTG();
    console.log('Готово для Instagram-пакета в TG:', posts.length);
    for (const post of posts) {
      const title = getProp(post.properties, 'Тема');
      try {
        const carouselText = getProp(post.properties, 'Insta-карусель');
        console.log('Готовлю Instagram-пакет:', title);
        const { imageUrls, caption } = await makeCarouselImages(title, carouselText);

        await notify(`📸 Instagram-пакет: *${title}*\n\nСейчас пришлю ${imageUrls.length} слайдов 4:5. Потом отдельным сообщением будет подпись.`, true);
        for (let i = 0; i < imageUrls.length; i += 1) {
          await notifyPhoto(imageUrls[i], `Слайд ${i + 1}/${imageUrls.length}: ${title}`);
        }
        await notify(`Подпись для Instagram:\n\n${caption}`, false);

        await updatePage(post.id, { 'Instagram в TG': checkboxProp(true) });
        console.log('Instagram-пакет отправлен в TG:', title);
      } catch (e) {
        console.error('Ошибка Instagram-пакета:', title, e.message);
        await notify(`Ошибка Instagram-пакета "${title}": ${e.message}`, false);
      }
    }
  } catch (e) {
    console.error('Ошибка цикла Instagram-пакетов:', e.message);
  }
}

setInterval(sendInstagramPackageCycle, INSTAGRAM_INTERVAL_MINUTES * 60 * 1000);
sendInstagramPackageCycle();
