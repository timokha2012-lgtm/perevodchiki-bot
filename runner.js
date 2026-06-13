'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

// ─── VK GROUP COUNTER (persists across scheduler ticks via file) ──────────────
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
    let patchesApplied = [];

  // ── PATCH 1: video.save → use user token (add ", true" as 2nd arg to vkCall) ──
  // Matches:  vkCall('video.save', {   ...   wallpost: 0\n  });
  // The regex is tolerant of different indentation/whitespace.
  const videoSavePatched = /vkCall\('video\.save',\s*\{[^}]*wallpost:\s*0\s*\},\s*true\s*\)/.test(code);
    if (!videoSavePatched) {
          const videoSaveRE = /(vkCall\('video\.save',\s*\{[^}]*wallpost:\s*0\s*\})\s*\)/;
          if (!videoSaveRE.test(code)) {
                  throw new Error('PATCH1 target (video.save) not found in perevodchiki_bot.js');
          }
          code = code.replace(videoSaveRE, '$1, true)');
          patchesApplied.push('video.save→userToken');
    } else {
          patchesApplied.push('video.save→userToken(already)');
    }

  // ── PATCH 2: Dzen checkbox — when dzenMatch fires, also set Dzen=true ────────
  // Looks for:   if (dzenMatch) updates['Dzen-текст'] = richText(...)
  // Replaces with a block that also sets updates['Dzen'] = checkboxProp(true)
  const dzenProp = 'Dzen-\u0442\u0435\u043a\u0441\u0442';
    const dzenAlreadyPatched = new RegExp(
          "if\\s*\\(dzenMatch\\)\\s*\\{[\\s\\S]*?updates\\['Dzen'\\]\\s*=\\s*checkboxProp\\(true\\)"
        ).test(code);

  if (!dzenAlreadyPatched) {
        const dzenOldRE = new RegExp(
                "([ \\t]*)if\\s*\\(dzenMatch\\)\\s+updates\\['" +
                dzenProp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                "'\\]\\s*=\\s*richText\\(dzenMatch\\[1\\]\\.trim\\(\\)\\);"
              );
        if (!dzenOldRE.test(code)) {
                throw new Error('PATCH2 target (Dzen checkbox) not found in perevodchiki_bot.js');
        }
        code = code.replace(dzenOldRE, (_, indent) =>
                `${indent}if (dzenMatch) {\n` +
                `${indent}  updates['${dzenProp}'] = richText(dzenMatch[1].trim());\n` +
                `${indent}  updates['Dzen'] = checkboxProp(true);\n` +
                `${indent}}`
                                );
        patchesApplied.push('Dzen→checkbox');
  } else {
        patchesApplied.push('Dzen→checkbox(already)');
  }

  // ── PATCH 3: VK group rotation — use persistent counter instead of loop index ─
  // publishVKCycle uses:  const groupId = vkGroupForPost(i);
  // We replace it with a persistent counter read from file.
  const vkRotationPatched = code.includes('readVKCounter()');
    if (!vkRotationPatched) {
          const rotationOldRE = /(const groupId = vkGroupForPost\()\s*i\s*(\);)/;
          if (rotationOldRE.test(code)) {
                  // Inject counter helper into the code and replace the call
            const counterHelper =
                      '\n// injected by runner.js — persistent VK group rotation\n' +
                      'const __fs = require(\'fs\'), __cpath = require(\'path\').join(__dirname, \'.vk_post_counter\');\n' +
                      'function readVKCounter() { try { return parseInt(__fs.readFileSync(__cpath,\'utf8\').trim(),10)||0; } catch(_){return 0;} }\n' +
                      'function writeVKCounter(n) { try { __fs.writeFileSync(__cpath,String(n),\'utf8\'); } catch(_){} }\n';

            // Insert helper near the top (after the first 'use strict' or after requires)
            code = code.replace(
                      /^((?:['"]use strict['"];?\n)?(?:const|let|var) \w+ = require\([^)]+\);?\n)/,
                      '$1' + counterHelper
                    );

            code = code.replace(
                      rotationOldRE,
                      'const __vkIdx = readVKCounter(); writeVKCounter(__vkIdx + 1);\n      const groupId = vkGroupForPost(__vkIdx'
                    );
                  patchesApplied.push('VK-rotation→persistent');
          } else {
                  patchesApplied.push('VK-rotation(not found, skipped)');
          }
    } else {
          patchesApplied.push('VK-rotation(already)');
    }

  console.log('[runner] Patches applied:', patchesApplied.join(', '));

  const botModule = new Module(filename, module);
    botModule.filename = filename;
    botModule.paths = Module._nodeModulePaths(__dirname);
    botModule._compile(code, filename);
    return botModule.exports;
}

requirePatchedBot('perevodchiki_bot.js');

require('./instagram_autopost');
