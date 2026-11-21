const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const doc = fs.readFileSync(
    path.join(root, 'Samples', 'Workspace.md'),
    'utf8',
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const out = process.env.SNAPSHOT_DIR;
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 860 },
      colorScheme: 'dark',
    });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.addInitScript(
      ({ doc }) => {
        const workspace = '/fixtures/Samples';
        const path = workspace + '/Workspace.md';
        const csv = workspace + '/Tasks.csv';
        const docs = new Map([
          [path, doc],
          [csv, 'Task,Name\nWrite,Sam\n'],
        ]);
        const entries = [
          { path: workspace + '/Notes', name: 'Notes', isDirectory: true },
          ...Array.from(docs.keys(), (p) => ({
            path: p,
            name: p.split('/').pop(),
          })),
        ];
        const record = (p) => ({
          path: p,
          name: p.split('/').pop(),
          text: docs.get(p),
        });
        let registered = [{ path: workspace, name: 'Samples' }];
        window.nativeWorkspace = workspace;
        window.startPickerScenario = () => {
          registered = [
            { path: '/fixtures/Work', name: 'Work' },
            { path: '/fixtures/Work/Writing', name: 'Writing' },
            { path: '/fixtures/Review', name: 'Review' },
          ];
          window.nativeWorkspace = '/fixtures/Review';
          const review = '/fixtures/Review/Overview.md';
          for (const [file, content] of [
            [review, '# Overview'],
            ['/fixtures/Work/Writing/Probe.txt', 'Writing probe'],
            ['/fixtures/Work/Writing/Archive/Week/Status.md', '# Status'],
            ['/fixtures/WorkArchive/Loose.txt', 'Independent file'],
          ]) {
            docs.set(file, content);
            entries.push({ path: file, name: file.split('/').pop() });
          }
          for (const dir of ['/fixtures/Work/Writing/Archive', '/fixtures/Work/Writing/Archive/Week']) {
            entries.push({path: dir, name: dir.split('/').pop(), isDirectory: true});
          }
          window.outgoing.length = 0;
          window.hostEvent('bootstrap', {
            workspaces: registered, activeWorkspace: window.nativeWorkspace,
            files: [record(review)], activePath: review, settings: { recents: [] },
          });
        };
        window.outgoing = [];
        window.webkit = {
          messageHandlers: {
            host: {
              postMessage(m) {
                outgoing.push(m);
                const fire = (t, p) =>
                  setTimeout(() => window.hostEvent(t, p), 0);
                switch (m.type) {
                  case 'ready':
                    fire('bootstrap', {
                      workspaces: registered,
                      activeWorkspace: workspace,
                      files: [record(path)],
                      activePath: path,
                      settings: {},
                    });
                    break;
                  case 'listFolder':
                    fire('listing', {
                      path: m.path,
                      entries: entries.filter((e) => e.path.slice(0, e.path.lastIndexOf('/')) === m.path),
                    });
                    break;
                  case 'chooseWorkspace':
                    if (registered.some((r) => r.path === m.path)) {
                      window.nativeWorkspace = m.path;
                      fire('activeWorkspace', { path: m.path });
                    }
                    break;
                  case 'read': {
                    const owner = registered.filter((r) => m.path.startsWith(r.path + '/'))
                      .sort((a,b) => b.path.length - a.path.length)[0];
                    if (owner && owner.path !== window.nativeWorkspace) {
                      window.nativeWorkspace = owner.path;
                      fire('activeWorkspace', { path: owner.path });
                    }
                    fire('document', record(m.path));
                    break;
                  }
                  case 'save':
                    if (window.queuedDiskVersion) {
                      docs.set(m.path, window.queuedDiskVersion);
                      window.queuedDiskVersion = null;
                    }
                    if (docs.get(m.path) !== m.baseText) {
                      fire('conflict', {
                        path: m.path,
                        text: docs.get(m.path),
                      });
                    } else {
                      docs.set(m.path, m.text);
                      fire('saved', { path: m.path, text: m.text });
                    }
                    break;
                  case 'searchFiles':
                    fire('searchResults', {
                      ...m,
                      entries:
                        m.mode === 'backlinks'
                          ? []
                          : entries.filter((e) => !e.isDirectory && (m.mode === 'quickOpen' ? e.path : e.name)
                              .toLowerCase().includes(m.query.toLowerCase())),
                    });
                    break;
                  case 'agentLink':
                    fire('agentLink', {
                      path: m.path,
                      url: 'http://localhost:12345/d/example',
                    });
                    break;
                }
              },
            },
          },
        };
        window.testDisk = docs;
        window.testPath = path;
      },
      { doc },
    );
    // Chromium restricts local-file font requests. Give the bundled assets a same-origin test URL.
    const resources = path.join(root, 'Resources');
    await page.route('http://samare-fixture.test/**', (route) => {
      const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
      const asset = path.resolve(resources, '.' + pathname);
      return asset.startsWith(resources + path.sep)
        ? route.fulfill({ path: asset })
        : route.abort();
    });
    await page.goto('http://samare-fixture.test/index.html');
    const editor = page.locator('#editor .ProseMirror');
    await editor.waitFor();
    const compositionEscape = await page.evaluate(async () => {
      const requests = () => window.outgoing.filter(message => message.type === 'exitFullScreen').length;
      const before = requests();
      document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:229, bubbles:true, cancelable:true}));
      await Promise.resolve();
      const afterIME = requests();
      document.body.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', keyCode:27, bubbles:true, cancelable:true}));
      await Promise.resolve();
      return [afterIME - before, requests() - afterIME];
    });
    assert.deepEqual(compositionEscape, [0, 1]);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await editor.evaluate(el => document.activeElement === el), true);
    const loadedFaces = await page.evaluate(async () => {
      const loaded = await Promise.all(['Geist Variable', 'Geist Mono Variable'].map(
        family => document.fonts.load('400 17px "' + family + '"', 'Aa'),
      ));
      return loaded.map(faces => faces.some(face => face.status === 'loaded'));
    });
    assert.deepEqual(loadedFaces, [true, true]);
    assert.equal(await page.locator('#counter').getAttribute('aria-label'), '54 words · 347 characters');
    await page.getByRole('button', {name:'More actions'}).click();
    assert.equal(await page.getByRole('menuitem', {name:'Add properties'}).count(), 0);
    await page.getByRole('menuitem', {name:'Word count'}).click();
    assert.equal(await page.locator('#toast').innerText(), '54 words');
    assert.equal(await page.locator('#counter').isVisible(), true);
    await page.evaluate(() => hostEvent('command', 'shortcuts'));
    const help = page.getByRole('dialog', {name:'Keyboard shortcuts'});
    assert.deepEqual(await help.getByRole('heading').allTextContents(), ['Navigation','Files','Tabs','Panels']);
    assert.equal(await help.locator('li').count(), 18);
    assert.equal(await help.getByText('Jump to last tab').locator('..').locator('kbd').allTextContents().then(a=>a.join(' ')), '⌘ 9');
    await page.keyboard.press('Escape');
    assert.equal(
      await page
        .locator('#surface')
        .boundingBox()
        .then((r) => r.x),
      266,
    );
    assert.equal(
      await page
        .locator('#column')
        .boundingBox()
        .then((r) => r.width),
      624,
    );
    const coords = await page
      .locator('#editor .ProseMirror')
      .evaluate((n) =>
        Array.from(n.querySelectorAll('h1,h2,table,.de-codebox')).map((x) => ({
          type: x.nodeName,
          y: Math.round(x.getBoundingClientRect().top),
          height: Math.round(x.getBoundingClientRect().height),
        })),
      );
    console.log('Sample layout', JSON.stringify(coords));
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      await page.screenshot({ path: path.join(out, 'workspace-dark.png') });
    }
    const content = page.locator('#editor .ProseMirror');
    await page.getByRole('tab', {name:'Workspace', exact:true}).waitFor();
    await content.focus();
    await page.evaluate(() => hostEvent('command', 'palette'));
    const palette = page.getByRole('dialog', {name:'Command palette'});
    const query = palette.getByRole('textbox', {name:'Search commands...'});
    await query.waitFor();
    assert.equal(await palette.getByRole('listbox').count(), 0);
    await palette.getByRole('button', {name:/^Bold/}).waitFor();
    assert.equal(await page.locator('#layout').evaluate(n => n.inert), true);
    await query.press('ArrowDown');
    assert.match(await palette.locator('.choice.current').innerText(), /^Italic/);
    await query.press('Control+Alt+ArrowDown');
    assert.match(await palette.locator('.choice.current').innerText(), /^Italic/);
    await query.fill('nothing matches these words');
    assert.equal(await palette.locator('.choice.current').count(), 0);
    await query.press('Tab');
    assert.equal(await query.evaluate(n => n === document.activeElement), true);
    await query.press('Escape');
    assert.equal(await content.evaluate(n => n === document.activeElement), true);
    assert.equal(await page.locator('#layout').evaluate(n => n.inert), false);
    await page.evaluate(() => hostEvent('command', 'palette'));
    await query.fill('zoom');
    await palette.getByRole('button',{name:/^Zoom Out/}).press('Enter');
    assert.ok(await page.locator('#column').evaluate(n => Number(n.style.zoom) < 1));
    await page.evaluate(() => hostEvent('command', 'zoomReset'));
    await page.evaluate(() => hostEvent('command', 'palette'));
    assert.equal(await page.locator('.dialog').evaluate(el => el.clientWidth + 2), 500);
    assert.equal(await page.locator('.choice').first().evaluate(el => getComputedStyle(el).fontSize), '14px');
    await page.locator('.query').fill('wide');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#surface.wide').count(), 1);
    await page.getByRole('button', {name:'More actions'}).click();
    await page.getByRole('menuitem', {name:'Standard width'}).waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(() => hostEvent('command','palette'));
    await page.locator('.query').fill('wide');
    await palette.getByRole('button',{name:'Standard width'}).click();
    assert.equal(await page.locator('#surface.wide').count(), 0);
    await page.evaluate(() => hostEvent('command','wide'));
    await page.evaluate(() => hostEvent('command', 'focus'));
    assert.equal(await page.locator('#tabs').isVisible(), false);
    assert.equal(await page.locator('#tools button:visible').count(), 1);
    assert.equal(await page.locator('#focus-document').innerText(), 'Workspace');
    const leaveFocus = page.getByRole('button', {name:'Leave Focus', exact:true});
    assert.equal(await leaveFocus.getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => hostEvent('nativeFullscreen', true));
    assert.equal(await page.locator('#focus-document').isVisible(), false);
    assert.equal(await page.locator('#layout').evaluate(el => el.clientHeight === innerHeight), true);
    await page.mouse.move(400,300);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('focus-toggle')).opacity === '0');
    await leaveFocus.hover();
    await page.waitForFunction(() => getComputedStyle(document.getElementById('focus-toggle')).opacity === '1');
    await page.evaluate(() => hostEvent('nativeFullscreen', false));
    assert.equal(await page.locator('#focus-document').isVisible(), true);
    await leaveFocus.click();
    assert.equal(await page.locator('#tabs').isVisible(), true);
    assert.equal(await page.locator('#focus-toggle').getAttribute('aria-pressed'), 'false');
    await content.focus();
    await page.evaluate(() => hostEvent('command', 'find'));
    const matchCase = page.getByRole('button', {name:'Match case'});
    assert.equal(await matchCase.getAttribute('aria-pressed'), 'false');
    await matchCase.click();
    assert.equal(await matchCase.getAttribute('aria-pressed'), 'true');
    await page.getByPlaceholder('Find in page').fill('cat-not-here');
    assert.equal(
      await page.locator('#findbar output').innerText(),
      'No matches',
    );
    await page.getByPlaceholder('Find in page').fill('Table');
    assert.match(await page.locator('#findbar output').innerText(), /1 of 1/);
    await page.keyboard.press('Escape');
    assert.equal(await content.evaluate(n => n === document.activeElement), true);
    await page.getByRole('button', { name: 'Tasks.csv', exact: true }).click();
    await page.getByRole('button', { name: 'Source', exact: true }).waitFor();
    await page.getByRole('button', {name:'More actions'}).click();
    assert.equal(await page.getByRole('menuitem', {name:'Wide view'}).count(), 0);
    assert.equal(await page.getByRole('menuitem', {name:'Export as PDF…'}).isDisabled(), true);
    await page.keyboard.press('Escape');
    if (out) await page.screenshot({ path: path.join(out, 'data-table.png') });
    // An earlier cell's debounce must not write a second cell still being edited.
    const csvPath = '/fixtures/Samples/Tasks.csv';
    const taskCell = page.getByRole('textbox',{name:'Row 1, Task',exact:true});
    const nameCell = page.getByRole('textbox',{name:'Row 1, Name',exact:true});
    await taskCell.fill('Draft task');
    await taskCell.press('Tab');
    await nameCell.fill('Pending owner');
    await page.waitForFunction(p=>testDisk.get(p).includes('Draft task,Sam'),csvPath);
    assert.equal(await nameCell.inputValue(),'Pending owner');
    await nameCell.press('Escape');
    assert.equal(await nameCell.inputValue(),'Sam');
    await nameCell.fill('Saved owner');
    await page.evaluate(()=>hostEvent('command','save'));
    await page.waitForFunction(p=>testDisk.get(p).includes('Draft task,Saved owner'),csvPath);
    await nameCell.fill('Flushed owner');
    await page.evaluate(()=>hostEvent('flush',{id:'csv-close',reason:'quit'}));
    await page.waitForFunction(p=>testDisk.get(p).includes('Draft task,Flushed owner') && outgoing.some(m=>m.type==='flushed'&&m.id==='csv-close'&&m.ok),csvPath);
    await nameCell.fill('Shared owner');
    await page.evaluate(()=>hostEvent('command','agent'));
    await page.waitForFunction(p=>testDisk.get(p).includes('Draft task,Shared owner') && outgoing.some(m=>m.type==='agentLink' && m.path===p),csvPath);
    await nameCell.fill('Closed owner');
    await page.evaluate(() => hostEvent('command', 'closeTab'));
    await editor.waitFor();
    assert.equal(await page.evaluate(p=>testDisk.get(p),csvPath),'Task,Name\nDraft task,Closed owner\n');
    await page.evaluate(() => hostEvent('command', 'reopenTab'));
    await page.getByRole('button', { name: 'Source', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await editor.waitFor();
    await page.evaluate(() => hostEvent('command', 'agent'));
    await page.waitForFunction(() =>
      outgoing.some((m) => m.type === 'copy' && m.text.includes('/d/example')),
    );
    await page.evaluate(() => hostEvent('command', 'theme'));
    assert.equal(
      await page.locator('html').getAttribute('data-theme'),
      'light',
    );
    if (out) {
      await page.evaluate(() => hostEvent('command', 'wide'));
      await page.screenshot({ path: path.join(out, 'workspace-light.png') });
      await page.evaluate(() => hostEvent('command', 'palette'));
      await page.screenshot({ path: path.join(out, 'command-palette.png') });
      await page.keyboard.press('Escape');
    }
    const p = editor.locator('p').first();
    await p.click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Local edit.');
    await page.waitForFunction(() =>
      testDisk.get(testPath).includes('Local edit.'),
    );
    await page.evaluate(() => {
      const t = testDisk
        .get(testPath)
        .replace('Field notes', 'External heading');
      testDisk.set(testPath, t);
      hostEvent('externalChange', { path: testPath, text: t });
    });
    await page.getByRole('heading', { name: 'External heading' }).waitFor();
    // Replace the first heading locally and on disk inside the save debounce.
    await editor.locator('h1').click();
    await page.evaluate(() => {
      window.queuedDiskVersion = testDisk
        .get(testPath)
        .replace('External heading', 'Agent title');
      const h = document.querySelector('.ProseMirror h1');
      const sel = getSelection(),
        r = document.createRange();
      r.selectNodeContents(h);
      sel.removeAllRanges();
      sel.addRange(r);
    });
    await page.keyboard.insertText('My title');
    await page.getByRole('dialog', {name:'Choose which version to keep'}).waitFor();
    assert.equal(await editor.getByText(/<<<<<<<|>>>>>>>/).count(),0);
    await page
      .getByRole('button', { name: /^New version/ })
      .click();
    await page.waitForFunction(
      () =>
        testDisk.get(testPath).includes('Agent title') &&
        !testDisk.get(testPath).includes('<<<<<<<'),
    );
    await page.evaluate(() =>
      hostEvent('flush', { id: 'qa-close', reason: 'quit' }),
    );
    await page.waitForFunction(() =>
      outgoing.some((m) => m.type === 'flushed' && m.id === 'qa-close' && m.ok),
    );
    await page.evaluate(() => window.startPickerScenario());
    const review = '/fixtures/Review', writing = '/fixtures/Work/Writing';
    const probe = writing + '/Probe.txt';
    const selectedTab = page.locator('[role=tab][aria-selected=true]');
    const quickSelect = async (name) => {
      await page.keyboard.press('Meta+p');
      await page.getByPlaceholder('Search workspaces or files...').fill(name);
      await page.getByRole('dialog',{name:'Open workspace or file'}).getByRole('button', { name }).first().waitFor();
      await page.keyboard.press('Enter');
    };
    const assertWorkspace = async (rootPath) => {
      await page.getByRole('textbox', { name: 'Search ' + rootPath.split('/').pop(), exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.nativeWorkspace), rootPath);
    };
    const probeReads = () => page.evaluate(
      (file) => outgoing.filter((msg) => msg.type === 'read' && msg.path === file).length, probe,
    );
    await assertWorkspace(review);
    await quickSelect('Probe.txt');
    await assertWorkspace(writing);
    await page.locator('[role=tab][title="' + probe + '"][aria-selected=true]').waitFor();
    assert.equal(await probeReads(), 1);

    await page.keyboard.press('Meta+p');
    await page.getByPlaceholder('Search workspaces or files...').fill('Archive/Week');
    await page.getByRole('dialog',{name:'Open workspace or file'}).getByRole('button', {name:/^Status/}).click();
    await page.locator('.file-row.selected[title="/fixtures/Work/Writing/Archive/Week/Status.md"]').waitFor();
    await page.getByRole('button',{name:'More actions'}).click();
    await page.getByRole('menuitem',{name:'Add properties'}).waitFor();
    await page.keyboard.press('Escape');
    await quickSelect('Probe.txt');
    await quickSelect('Review');
    await assertWorkspace(review);
    assert.equal(await selectedTab.getAttribute('title'), probe);
    await page.locator('[role=tab][title="/fixtures/Review/Overview.md"]').click();
    await page.locator('[role=tab][title="' + probe + '"]').click();
    await assertWorkspace(review);
    await quickSelect('Probe.txt');
    await assertWorkspace(writing);
    assert.equal(await selectedTab.getAttribute('title'), probe);
    assert.equal(await probeReads(), 1);

    await quickSelect('Loose.txt');
    await page.getByRole('button', { name: 'Open files', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Loose.txt', exact: true }).waitFor();
    assert.equal(await selectedTab.getAttribute('title'), '/fixtures/WorkArchive/Loose.txt');
    assert.equal(await page.evaluate(() => window.nativeWorkspace), writing);
    await page.evaluate(() => {
      const lines = Array.from({length:300}, (_, i) => (i + 1) + ',item ' + (i + 1));
      hostEvent('document', {path:'/fixtures/Large.csv', name:'Large.csv', text:'ID,Name\n' + lines.join('\n')});
      hostEvent('command', 'find');
    });
    const search = page.locator('#findbar input');
    await search.fill('item 291');
    assert.equal(await page.locator('#findbar output').innerText(), '1 of 1');
    const hit = page.locator('.find-cell');
    assert.equal(await hit.inputValue(), 'item 291');
    assert.equal(await search.evaluate(el => el === document.activeElement), true);
    await search.fill('item ');
    await page.keyboard.press('Shift+Enter');
    assert.equal(await page.locator('#findbar output').innerText(), '300 of 300');
    assert.equal(await hit.inputValue(), 'item 300');
    await search.fill('missing item value');
    assert.equal(await page.locator('#findbar output').innerText(), 'No matches');
    assert.equal(await hit.count(), 0);
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    console.log(
      'PASS workspace layout, command palette, per-file width, focus, find, data tabs, reopen, copy, theme, save, external change, conflict decision, quit handshake and cross-workspace Quick Open for closed/open tabs, nested roots and independent files.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
