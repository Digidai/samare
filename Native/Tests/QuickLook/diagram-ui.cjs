// Run with PLAYWRIGHT_MODULE and, optionally, CHROME_PATH set to local installations.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

(async () => {
  const root = path.resolve(__dirname, '../../..');
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH});
  try {
    const page = await browser.newPage({viewport:{width:1250,height:900}});
    const remote = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) remote.push(request.url()); });
    await page.goto(pathToFileURL(path.join(root, 'Resources/index.html')).href);
    await page.evaluate(() => {
      const fixture = document.createElement('div');
      document.body.append(fixture);
      const style = document.createElement('style');
      style.textContent = '.de-diagram{width:var(--qa-width)!important}';
      document.head.append(style);
      document.documentElement.style.setProperty('--qa-width','1200px');
      const flow = 'flowchart LR\nA-->B-->C-->D-->E-->F-->G-->H-->I-->J-->K-->L';
      const pie = 'pie\n "Build" : 67\n "Review" : 33';
      const source = '# Diagrams\n\n' + [flow,pie].map(s => '```mermaid\n'+s+'\n```').join('\n\n');
      window.fixture = fixture;
      SamareEditor.mount(fixture, {path:'diagram-fixture.md',text:source,settings:{contentWidth:'100%'}});
    });
    await page.waitForFunction(() => fixture.querySelectorAll('.samare-diagram svg').length === 2);
    const sample = () => page.evaluate(() => {
      const svg = fixture.querySelector('.pele-flowchart');
      const bounds = svg.viewBox.baseVal;
      const pie = fixture.querySelector('.pele-pie');
      return {width:bounds.width,height:bounds.height,series:getComputedStyle(pie).getPropertyValue('--pele-series-1').trim(),
        label:getComputedStyle(pie.querySelector('.pele-slice-labels[fill]')).fill};
    });
    const wide = await sample();
    assert(wide.width > wide.height * 3);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      document.documentElement.style.setProperty('--qa-width','320px');
    });
    await page.waitForFunction(() => {
      const {width,height} = fixture.querySelector('.pele-flowchart').viewBox.baseVal;
      return height > width * 3;
    });
    const narrow = await sample();
    assert.equal(wide.series,'#73bdff'); assert.equal(narrow.series,'#63b3ff');
    assert.equal(narrow.label,'rgb(24, 24, 27)');
    const html = await page.evaluate(async () => {
      await SamareDiagrams.ready();
      document.documentElement.style.setProperty('--qa-width','1200px');
      const copy = fixture.cloneNode(true);
      const css = SamareDiagrams.preparePrint(copy,624);
      const figures = [...copy.querySelectorAll('.samare-print-diagram')];
      return '<!doctype html><meta charset=utf-8><style>'+css+'</style>'+figures.map(el => el.outerHTML).join('');
    });
    const printed = await browser.newPage({colorScheme:'dark'});
    await printed.setContent(html);
    assert(await printed.evaluate(() => {
      const flow = document.querySelector('.pele-flowchart').viewBox.baseVal;
      const pie = document.querySelector('.pele-pie');
      return flow.height > 3 * flow.width && getComputedStyle(pie).getPropertyValue('--pele-series-1').trim() === '#73bdff';
    }));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], html);
    assert.deepEqual(remote,[]);
    console.log('Editor, 320 px reflow, 624 px print, and light/dark pie palettes passed.', {wide,narrow});
  } finally { await browser.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
