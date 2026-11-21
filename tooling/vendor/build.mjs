import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {readFile, writeFile, readdir, mkdir, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modules = path.join(root, 'node_modules');
const resources = path.join(root, 'Resources');
const vendor = path.join(resources, 'vendor');
const licenses = path.join(vendor, 'licenses');
const installed = name => path.join(modules, name);
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const asJSON = value => JSON.stringify(value, null, 2) + '\n';
const manifest = async name => readJSON(path.join(installed(name), 'package.json'));

await Promise.all([licenses, path.join(vendor, 'fonts'), path.join(resources, 'fonts'), path.join(resources, 'lib')].map(p => mkdir(p, {recursive:true})));
const editor = await build({
  absWorkingDir: root,
  entryPoints: ['tooling/vendor/editor-entry.mjs'],
  bundle: true, format: 'iife', globalName: 'SamareEditorLibs',
  minify: true, legalComments: 'eof', target: 'safari15', metafile: true,
  outfile: path.join(vendor, 'editor-libs.js'), write: false,
});

// Keep Prism in this file because the native Quick Look JSContext loads one editor library.
// Shadow browser globals so Prism never adds DOM hooks or starts a worker by itself.
const languages = ['core','clike','javascript','typescript','markup','css','bash','c','cpp','go',
  'java','kotlin','json','python','rust','swift','sql','yaml','markdown','latex'];
const grammar = await Promise.all(languages.map(lang => readFile(path.join(installed('prismjs'), 'components', 'prism-'+lang+'.min.js'), 'utf8')));
await writeFile(path.join(vendor, 'editor-libs.js'), editor.outputFiles[0].text +
  '\n/* PrismJS: MIT, Lea Verou. See licenses/prismjs.txt. */\n' +
  'var SamareScriptGrammar = (function () {\n  var window = {}, WorkerGlobalScope, module, global, document;\n' +
  grammar.join('\n') + '\n  Prism.languages.zsh = Prism.languages.bash;\n  return Prism;\n})();\n');

for (const [pkg, source, destination] of [
  ['mermaid', 'dist/mermaid.min.js', 'vendor/mermaid.min.js'],
  ['pele', 'dist/pele.global.js', 'vendor/pele.global.js'],
  ['js-yaml', 'dist/js-yaml.min.js', 'vendor/js-yaml.min.js'],
  ['katex', 'dist/katex.min.css', 'vendor/katex.min.css'],
  ['diff', 'dist/diff.min.js', 'lib/diff.min.js'],
  ['diff', 'LICENSE', 'lib/diff-LICENSE'],
]) {
  await copyFile(path.join(installed(pkg), source), path.join(resources, destination));
}
for (const font of await readdir(path.join(installed('katex'), 'dist/fonts'))) {
  if (font.endsWith('.woff2')) await copyFile(path.join(installed('katex'), 'dist/fonts', font), path.join(vendor, 'fonts', font));
}
for (const [family, notice] of [['geist', 'Geist-LICENSE'], ['geist-mono', 'GeistMono-LICENSE']]) {
  const pkg = installed('@fontsource-variable/'+family);
  await copyFile(path.join(pkg, 'LICENSE'), path.join(resources, 'fonts', notice));
  for (const subset of ['latin','latin-ext','cyrillic']) {
    const file = family+'-'+subset+'-wght-normal.woff2';
    await copyFile(path.join(pkg, 'files', file), path.join(resources, 'fonts', file));
  }
}

// name ID 13 in upstream TrueType files records the per-family reserved names
// and copyright of the equivalent WOFF2 copies. The npm archive ships all
// TrueType faces but does not ship a separate OFL text file.
function fontNotice(bytes) {
  for (let table = 0; table < bytes.readUInt16BE(4); table++) {
    const header = 12 + 16 * table;
    if (bytes.toString('ascii', header, header + 4) !== 'name') continue;
    const base = bytes.readUInt32BE(header + 8);
    const strings = base + bytes.readUInt16BE(base + 4);
    for (let n = 0; n < bytes.readUInt16BE(base + 2); n++) {
      const field = base + 6 + 12 * n;
      if (bytes.readUInt16BE(field) !== 3 || bytes.readUInt16BE(field + 6) !== 13) continue;
      const start = strings + bytes.readUInt16BE(field + 10);
      const data = bytes.subarray(start, start + bytes.readUInt16BE(field + 8));
      const notice = new TextDecoder('utf-16be').decode(data);
      if (!notice.includes('SIL Open Font License, Version 1.1')) throw Error('Unexpected KaTeX font license');
      return notice.split('\n\n')[0];
    }
  }
  throw Error('Missing KaTeX font name-table license');
}
const fontDir = path.join(installed('katex'), 'dist/fonts');
const families = new Set();
for (const file of (await readdir(fontDir)).filter(f => f.endsWith('.ttf')).sort()) {
  families.add(fontNotice(await readFile(path.join(fontDir, file))));
}
const ofl = await readFile(path.join(resources, 'fonts/Geist-LICENSE'), 'utf8');
const startOfl = ofl.indexOf('SIL OPEN FONT LICENSE Version 1.1');
if (startOfl === -1) throw Error('Missing OFL text');
await writeFile(path.join(licenses, 'katex-fonts.txt'), [...families].join('\n\n')+'\n\n'+ofl.slice(startOfl));

const names = new Set(['esbuild','mermaid','pele','prismjs','js-yaml','diff','@fontsource-variable/geist','@fontsource-variable/geist-mono']);
for (const input of Object.keys(editor.metafile.inputs)) {
  const match = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (match) names.add(match[1]);
}
const versions = {};
for (const pkg of [...names].sort()) {
  const metadata = await manifest(pkg);
  versions[pkg] = metadata.version;
  if (pkg === 'diff' || pkg.startsWith('@fontsource-variable/')) continue;
  const dir = installed(pkg);
  const licenseFile = (await readdir(dir)).find(f => /^licen[cs]e(?:\.md|\.txt)?$/i.test(f));
  if (!licenseFile) throw Error('Review upstream license for '+pkg);
  await copyFile(path.join(dir, licenseFile), path.join(licenses, pkg.replaceAll('/','-')+'.txt'));
}
await writeFile(path.join(vendor, 'versions.json'), asJSON(versions));

// Complete embedded Mermaid notices are checked in. The optional online refresh
// verifies each exact upstream archive named by the upstream bundle's source map.
const pins = await readJSON(path.join(root, 'tooling/vendor/mermaid-notice-sources.json'));
const combined = await readFile(path.join(licenses, 'mermaid-bundled.txt'));
for (const name of Object.keys(pins)) {
  if (!combined.includes(Buffer.from('\n'+name+'\n'))) throw Error('Missing embedded notice for '+name);
}
const tracked = ['vendor/editor-libs.js','vendor/mermaid.min.js','vendor/pele.global.js','vendor/js-yaml.min.js',
  'vendor/katex.min.css','lib/diff.min.js','vendor/licenses/mermaid-bundled.txt'];
for (const directory of ['fonts','vendor/fonts']) {
  for (const file of (await readdir(path.join(resources,directory))).sort()) if (file.endsWith('.woff2')) tracked.push(directory+'/'+file);
}
const hashes = {};
for (const file of tracked) hashes[file] = createHash('sha256').update(await readFile(path.join(resources, file))).digest('hex');
await writeFile(path.join(vendor, 'sha256.json'), asJSON(hashes));
console.log('Built '+tracked.length+' browser assets and verified '+Object.keys(pins).length+' Mermaid component notices.');
