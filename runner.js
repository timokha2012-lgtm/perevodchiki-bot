'use strict';
const fs = require('fs');
const path = require('path');
const Mod = require('module');

// Force VK publishing to morning. Railway can override with VK_MORNING_HOUR_MSK.
process.env.VK_RUN_HOUR_MSK = process.env.VK_MORNING_HOUR_MSK || '10';

const CFILE = path.join(__dirname, '.vk_post_counter');
function rdCtr() {
  try { return parseInt(fs.readFileSync(CFILE, 'utf8').trim(), 10) || 0; }
  catch (_) { return 0; }
}
function wrCtr(n) {
  try { fs.writeFileSync(CFILE, String(n), 'utf8'); } catch (_) {}
}

global.rdCtr = rdCtr;
global.wrCtr = wrCtr;

function requirePatchedBot(file) {
  const fname = path.join(__dirname, file);
  let code = fs.readFileSync(fname, 'utf8');
  const log = [];

  const P1_OLD = "    wallpost: 0\n  });\n  if (!saved || !saved.upload_url)";
  const P1_NEW = "    wallpost: 0\n  }, true);\n  if (!saved || !saved.upload_url)";
  if (!code.includes(P1_NEW)) {
    if (code.includes(P1_OLD)) {
      code = code.replace(P1_OLD, P1_NEW);
      log.push('P1:video.save->userToken');
    } else {
      console.warn('[runner] P1: target not found');
      log.push('P1:skip');
    }
  } else {
    log.push('P1:already');
  }

  const DPROP = 'Dzen-' + String.fromCharCode(1090, 1077, 1082, 1089, 1090);
  const P2_OLD = "    if (dzenMatch) updates['" + DPROP + "'] = richText(dzenMatch[1].trim());";
  const P2_NEW = "    if (dzenMatch) {\n" +
                 "      updates['" + DPROP + "'] = richText(dzenMatch[1].trim());\n" +
                 "      updates['Dzen'] = checkboxProp(true);\n" +
                 "    }";
  if (!code.includes(P2_NEW)) {
    if (code.includes(P2_OLD)) {
      code = code.replace(P2_OLD, P2_NEW);
      log.push('P2:Dzen->checkbox');
    } else {
      console.warn('[runner] P2: target not found');
      log.push('P2:skip');
    }
  } else {
    log.push('P2:already');
  }

  const P3_OLD = 'const groupId = vkGroupForPost(i);';
  if (!code.includes('/*vk-rotation-patched*/')) {
    if (code.includes(P3_OLD)) {
      code = code.replace(
        P3_OLD,
        '/*vk-rotation-patched*/\n      const __idx=rdCtr();wrCtr(__idx+1);\n      const groupId = vkGroupForPost(__idx);'
      );
      log.push('P3:VK-rotation');
    } else {
      log.push('P3:skip');
    }
  } else {
    log.push('P3:already');
  }

  const P4_OLD = "function uploadMultipart(uploadUrlString, fieldName, filename, buffer, mimeType) {\n  return new Promise((resolve, reject) => {\n    const u = new URL(uploadUrlString);\n    const boundary";
  const P4_NEW = "function uploadMultipart(uploadUrlString, fieldName, filename, buffer, mimeType) {\n  return new Promise((resolve, reject) => {\n    const u = new URL(uploadUrlString);\n    const __proto = u.protocol === 'http:' ? require('http') : require('https');\n    const boundary";
  if (!code.includes('const __proto = u.protocol')) {
    if (code.includes(P4_OLD)) {
      code = code.replace(P4_OLD, P4_NEW);
      const markerIdx = code.indexOf('const __proto = u.protocol');
      if (markerIdx > 0) {
        const before = code.substring(0, markerIdx);
        const after = code.substring(markerIdx).replace('const req = https.request({', 'const req = __proto.request({');
        code = before + after;
      }
      log.push('P4:uploadMultipart->http/https');
    } else {
      console.warn('[runner] P4: target not found');
      log.push('P4:skip');
    }
  } else {
    log.push('P4:already');
  }

  const P5_OLD = "if (uploaded.error) throw new Error('VK upload: ' + JSON.stringify(uploaded));";
  const P5_NEW = "if (uploaded.error || !uploaded.server) {\n" +
                 "          console.error('VK: upload server response:', JSON.stringify(uploaded));\n" +
                 "          throw new Error('VK upload failed: ' + JSON.stringify(uploaded).substring(0,200));\n" +
                 "        }";
  if (!code.includes('VK: upload server response')) {
    if (code.includes(P5_OLD)) {
      code = code.replace(P5_OLD, P5_NEW);
      log.push('P5:better-upload-error-log');
    } else {
      log.push('P5:skip');
    }
  } else {
    log.push('P5:already');
  }

  const P6_OLD = 'if (currentHour === VK_RUN_HOUR_MSK && lastVKRunDate !== dateKey) {';
  const P6_NEW = 'if (currentHour >= VK_RUN_HOUR_MSK && lastVKRunDate !== dateKey) {';
  if (!code.includes(P6_NEW)) {
    if (code.includes(P6_OLD)) {
      code = code.replace(P6_OLD, P6_NEW);
      log.push('P6:VK-after-hour-ok');
    } else {
      console.warn('[runner] P6: target not found');
      log.push('P6:skip');
    }
  } else {
    log.push('P6:already');
  }

  const P7_OLD = "const posted = await vkCall('wall.post', params);";
  const P7_NEW = "const posted = await vkCall('wall.post', params, true);";
  if (!code.includes(P7_NEW)) {
    if (code.includes(P7_OLD)) {
      code = code.replace(P7_OLD, P7_NEW);
      log.push('P7:wall.post->userToken');
    } else {
      console.warn('[runner] P7: target not found');
      log.push('P7:skip');
    }
  } else {
    log.push('P7:already');
  }

  console.log('[runner] forced VK_RUN_HOUR_MSK =', process.env.VK_RUN_HOUR_MSK);
  console.log('[runner] patches:', log.join(', '));

  const m = new Mod(fname, module);
  m.filename = fname;
  m.paths = Mod._nodeModulePaths(__dirname);
  m._compile(code, fname);
  return m.exports;
}

requirePatchedBot('perevodchiki_bot.js');
require('./instagram_autopost');
