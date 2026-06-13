'use strict';
const fs   = require('fs');
const path = require('path');
const Mod  = require('module');
const http  = require('http');
const https = require('https');

// Persistent VK group counter
const CFILE = path.join(__dirname, '.vk_post_counter');
function rdCtr() {
  try { return parseInt(fs.readFileSync(CFILE, 'utf8').trim(), 10) || 0; }
  catch (_) { return 0; }
}
function wrCtr(n) {
  try { fs.writeFileSync(CFILE, String(n), 'utf8'); } catch (_) {}
}

function requirePatchedBot(file) {
  const fname = path.join(__dirname, file);
  let code = fs.readFileSync(fname, 'utf8');
  const log = [];

  // P1: video.save -> use VK_USER_TOKEN (add ", true" as 2nd arg to vkCall)
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
  } else { log.push('P1:already'); }

  // P2: Dzen checkbox
  const DPROP = 'Dzen-\u0442\u0435\u043a\u0441\u0442';
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
  } else { log.push('P2:already'); }

  // P3: VK group rotation
  const P3_OLD = 'const groupId = vkGroupForPost(i);';
  if (!code.includes('/*vk-rotation-patched*/')) {
    if (code.includes(P3_OLD)) {
      code = code.replace(P3_OLD,
        '/*vk-rotation-patched*/\n      const __idx=rdCtr();wrCtr(__idx+1);\n      const groupId = vkGroupForPost(__idx);'
      );
      global.rdCtr = rdCtr;
      global.wrCtr = wrCtr;
      log.push('P3:VK-rotation');
    } else { log.push('P3:skip'); }
  } else { log.push('P3:already'); }

  // P4: uploadMultipart — fix http:// vs https:// for VK upload servers
  // VK photo upload servers use http://, but original uploadMultipart uses https.request
  // We patch uploadMultipart to auto-select http/https based on URL protocol
  const P4_OLD = "function uploadMultipart(uploadUrlString, fieldName, filename, buffer, mimeType) {\n  return new Promise((resolve, reject) => {\n    const u = new URL(uploadUrlString);\n    const boundary";
  const P4_NEW = "function uploadMultipart(uploadUrlString, fieldName, filename, buffer, mimeType) {\n  return new Promise((resolve, reject) => {\n    const u = new URL(uploadUrlString);\n    const __proto = u.protocol === 'http:' ? require('http') : require('https');\n    const boundary";
  if (!code.includes('__proto')) {
    if (code.includes(P4_OLD)) {
      code = code.replace(P4_OLD, P4_NEW);
      // also fix the https.request call inside uploadMultipart to use __proto
      // The original: const req = https.request({
      // Replace only the FIRST occurrence after our patch marker
      const markerIdx = code.indexOf('const __proto = u.protocol');
      if (markerIdx > 0) {
        const afterMarker = code.substring(markerIdx);
        const fixedAfter = afterMarker.replace('const req = https.request({', 'const req = __proto.request({');
        code = code.substring(0, markerIdx) + fixedAfter;
      }
      log.push('P4:uploadMultipart->http/https');
    } else {
      console.warn('[runner] P4: uploadMultipart signature not matched, skipping');
      log.push('P4:skip');
    }
  } else { log.push('P4:already'); }

  // P5: photos.saveWallPhoto — add detailed error logging
  // When photo upload fails, log the full 'uploaded' object for debugging
  const P5_OLD = "if (uploaded.error) throw new Error('VK upload: ' + JSON.stringify(uploaded));";
  const P5_NEW = "if (uploaded.error || !uploaded.server) {\n" +
                 "          console.error(' VK: upload server response:', JSON.stringify(uploaded));\n" +
                 "          throw new Error('VK upload failed: ' + JSON.stringify(uploaded).substring(0,200));\n" +
                 "        }";
  if (!code.includes('VK: upload server response')) {
    if (code.includes(P5_OLD)) {
      code = code.replace(P5_OLD, P5_NEW);
      log.push('P5:better-upload-error-log');
    } else { log.push('P5:skip'); }
  } else { log.push('P5:already'); }

  console.log('[runner] patches:', log.join(', '));

  const m = new Mod(fname, module);
  m.filename = fname;
  m.paths = Mod._nodeModulePaths(__dirname);
  m._compile(code, fname);
  return m.exports;
}

requirePatchedBot('perevodchiki_bot.js');
require('./instagram_autopost');
