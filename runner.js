const fs = require('fs');

const path = require('path');

const Module = require('module');

function requirePatchedBot(file) {

  const filename = path.join(__dirname, file);

  let code = fs.readFileSync(filename, 'utf8');

  const oldVideoSave = "    wallpost: 0\n  });\n  if (!saved || !saved.upload_url)";

  const newVideoSave = "    wallpost: 0\n  }, true);\n  if (!saved || !saved.upload_url)";

  if (!code.includes(newVideoSave)) {

      if (!code.includes(oldVideoSave)) {

          throw new Error('VK video.save patch target not found');

      }

      code = code.replace(oldVideoSave, newVideoSave);

  }

  const dzenTextProp = 'Dzen-\u0442\u0435\u043a\u0441\u0442';

  const oldDzen = "    if (dzenMatch) updates['" + dzenTextProp + "'] = richText(dzenMatch[1].trim());";

  const newDzen = "    if (dzenMatch) {\n      updates['" + dzenTextProp + "'] = richText(dzenMatch[1].trim());\n      updates['Dzen'] = checkboxProp(true);\n    }";

  if (!code.includes(newDzen)) {

      if (!code.includes(oldDzen)) {

          throw new Error('Dzen flag patch target not found');

      }

      code = code.replace(oldDzen, newDzen);

  }

  const botModule = new Module(filename, module);

  botModule.filename = filename;

  botModule.paths = Module._nodeModulePaths(__dirname);

  botModule._compile(code, filename);

  return botModule.exports;

}

requirePatchedBot('perevodchiki_bot.js');

require('./instagram_autopost');
