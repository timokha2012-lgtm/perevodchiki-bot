'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ─── VK GROUP COUNTER (persists via file across restarts/ticks) ──────────────
const COUNTER_FILE = path.join(__dirname, '.vk_post_counter');

function readVKCounter() {
  try { return parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10) || 0; }
  catch (_) { return 0; }
}

function writeVKCounter(n) {
  try { fs.writeFileSync(COUNTER_FILE, String(n), 'utf8'); } catch (_) {}
}

// ─── PATCH + COMPILE perevodchiki_bot.js ─────────────────────────────────────
function requirePatchedBot(file) {
  const filename = path.join(__dirname, file);
  let code = fs.readFileSync(filename, 'utf8');
  const patches = [];

  // PATCH 1: video.save -> use VK_USER_TOKEN (add ", true" as 2nd arg to vkCall)
  // Matches: vkCall('video.save', { ... wallpost: 0 });
  // /s flag makes . match newlines
  const p1Already = /vkCall('video.save',s*{[sS]*?wallpost:s*0s*},s*trues*)/.test(code);
  if (!p1Already) {
    const p1re = /(vkCall('video.save',s*{[sS]*?wallpost:s*0s*})s*)/;
    if (!p1re.test(code)) {
      throw new Error('[runner] PATCH1 target not found: vkCall video.save');
    }
    code = code.replace(p1re, '$1, true)');
    patches.push('video.save->userToken');
  } else {
    patches.push('video.save->userToken(already)');
  }

  // PATCH 2: Dzen flag - when dzenMatch fires, also set checkbox Dzen=true
  const DZEN_TEXT_PROP = 'Dzen-\u0442\u0435\u043a\u0441\u0442';
  const p2Already = /ifs*(dzenMatch)s*{[sS]*?updates['Dzen']/.test(code);
  if (!p2Already) {
    // Match: <indent>if (dzenMatch) updates['Dzen-текст'] = richText(dzenMatch[1].trim());
    const p2re = new RegExp(
      '([ \t]*)if\s*\(dzenMatch\)\s+' +
      "updates\['Dzen-\u0442\u0435\u043a\u0441\u0442'\]" +
      '\s*=\s*richText\(dzenMatch\[1\]\.trim\(\)\);'
    );
    if (!p2re.test(code)) {
      throw new Error('[runner] PATCH2 target not found: Dzen checkbox line');
    }
    code = code.replace(p2re, function(_, indent) {
      return indent + "if (dzenMatch) {\n" +
        indent + "  updates['" + DZEN_TEXT_PROP + "'] = richText(dzenMatch[1].trim());\n" +
        indent + "  updates['Dzen'] = checkboxProp(true);\n" +
        indent + "}";
    });
    patches.push('Dzen->checkbox');
  } else {
    patches.push('Dzen->checkbox(already)');
  }

  // PATCH 3: VK group rotation via persistent counter
  // Target: const groupId = vkGroupForPost(i);
  // Inject counter read/write inline (using require so it's in scope)
  const p3Already = code.includes('__vkIdx = readVKCounter');
  if (!p3Already) {
    const p3re = /const groupId = vkGroupForPost(i);/;
    if (p3re.test(code)) {
      // Inject counter helpers at top of file (after first require line)
      const helperCode =
        "\nconst __ctrFs = require('fs'), __ctrPath = require('path').join(__dirname, '.vk_post_counter');\n" +
        "function __readVKIdx(){try{return parseInt(__ctrFs.readFileSync(__ctrPath,'utf8').trim(),10)||0;}catch(_){return 0;}}\n" +
        "function __writeVKIdx(n){try{__ctrFs.writeFileSync(__ctrPath,String(n),'utf8');}catch(_){}}\n";
      code = code.replace(/^('use strict';\n)?/, '$1' + helperCode);

      code = code.replace(p3re,
        'const __vkIdx = __readVKIdx(); __writeVKIdx(__vkIdx + 1);\n      const groupId = vkGroupForPost(__vkIdx);'
      );
      patches.push('VK-rotation->counter');
    } else {
      patches.push('VK-rotation(not found, skip)');
    }
  } else {
    patches.push('VK-rotation(already)');
  }

  console.log('[runner] Patches applied:', patches.join(', '));

  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(code, filename);
  return m.exports;
}

requirePatchedBot('perevodchiki_bot.js');
require('./instagram_autopost');
