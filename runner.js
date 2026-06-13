'use strict';
const fs   = require('fs');
const path = require('path');
const Mod  = require('module');

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

  // P1: video.save -> use VK_USER_TOKEN (add ", true" second arg to vkCall)
  // Exact target string from perevodchiki_bot.js (4-space indent inside object):
  const P1_OLD = "    wallpost: 0\n  });\n  if (!saved || !saved.upload_url)";
  const P1_NEW = "    wallpost: 0\n  }, true);\n  if (!saved || !saved.upload_url)";
  if (!code.includes(P1_NEW)) {
    if (code.includes(P1_OLD)) {
      code = code.replace(P1_OLD, P1_NEW);
      log.push('P1:video.save->userToken');
    } else {
      console.warn('[runner] P1: target not found, video.save may use group token');
      log.push('P1:skip');
    }
  } else { log.push('P1:already'); }

  // P2: Dzen checkbox – when dzenMatch set also Dzen=true
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
      console.warn('[runner] P2: Dzen target not found');
      log.push('P2:skip');
    }
  } else { log.push('P2:already'); }

  // P3: VK group rotation via persistent counter
  // vkGroupForPost(i) -> vkGroupForPost(counter)
  const P3_OLD = 'const groupId = vkGroupForPost(i);';
  if (!code.includes('/*vk-rotation-patched*/')) {
    if (code.includes(P3_OLD)) {
      const p3replacement =
        '/*vk-rotation-patched*/' +
        'const __idx=rdCtr();wrCtr(__idx+1);\n' +
        '      const groupId = vkGroupForPost(__idx);';
      code = code.replace(P3_OLD, p3replacement);
      // expose rdCtr/wrCtr globally so compiled code can call them
      global.rdCtr = rdCtr;
      global.wrCtr = wrCtr;
      log.push('P3:VK-rotation');
    } else {
      log.push('P3:skip');
    }
  } else { log.push('P3:already'); }

  console.log('[runner] patches:', log.join(', '));

  const m = new Mod(fname, module);
  m.filename = fname;
  m.paths = Mod._nodeModulePaths(__dirname);
  m._compile(code, fname);
  return m.exports;
}

requirePatchedBot('perevodchiki_bot.js');
require('./instagram_autopost');
