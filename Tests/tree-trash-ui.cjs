const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const resources = path.resolve(__dirname, '../Resources');
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      const root = '/Fixture';
      const names = [
        'Folder',
        'Folder/Child.md',
        'A.md',
        'B.md',
        'C.md',
        'D.md',
        'E.md',
        'F.md',
        'Z'.repeat(90) + '.md',
      ];
      const entries = new Map(
        names.map((n) => {
          const path = root + '/' + n;
          return [
            path,
            { path, name: n.split('/').pop(), isDirectory: n === 'Folder' },
          ];
        }),
      );
      const content = new Map(
        names.map((n) => [root + '/' + n, '# ' + n + '\n']),
      );
      const fire = (t, p) => setTimeout(() => window.hostEvent(t, p), 0);
      window.trashTest = { messages: [], disk: entries };
      const doc = (p) => ({
        path: p,
        name: p.split('/').pop(),
        text: content.get(p),
      });
      window.webkit = {
        messageHandlers: {
          host: {
            postMessage(m) {
              window.trashTest.messages.push({ ...m, at: Date.now() });
              switch (m.type) {
                case 'ready':
                  return fire('bootstrap', {
                    workspaces: [{ path: root, name: 'Fixture' }],
                    activeWorkspace: root,
                    files: [doc(root + '/A.md')],
                    activePath: root + '/A.md',
                    settings: {},
                  });
                case 'listFolder':
                  return fire('listing', {
                    path: m.path,
                    entries: [...entries.values()].filter(
                      (e) =>
                        e.path.slice(0, e.path.lastIndexOf('/')) === m.path,
                    ),
                  });
                case 'read':
                  return fire('document', doc(m.path));
                case 'save':
                  if (window.trashTest.denySave)
                    return fire('saveError', {
                      path: m.path,
                      message: 'Read-only fixture',
                    });
                  content.set(m.path, m.text);
                  return fire('saved', { path: m.path, text: m.text });
                case 'trashBatch': {
                  const errors = [];
                  for (const p of m.paths) {
                    if (window.trashTest.denyTrash === p) {
                      errors.push('Could not trash ' + p);
                      continue;
                    }
                    for (const key of entries.keys())
                      if (key === p || key.startsWith(p + '/'))
                        entries.delete(key);
                    fire('trashed', { path: p });
                  }
                  const result = () =>
                    fire('trashBatchResult', { id: m.id, errors });
                  if (window.trashTest.holdReceipt)
                    window.trashTest.release = result;
                  else result();
                }
              }
            },
          },
        },
      };
    });
    await page.route('http://tree-fixture.test/**', (route) => {
      const pathname = decodeURIComponent(
        new URL(route.request().url()).pathname,
      );
      const file = path.resolve(resources, '.' + pathname);
      return file.startsWith(resources + path.sep)
        ? route.fulfill({ path: file })
        : route.abort();
    });
    const start = async () => {
      await page.goto('http://tree-fixture.test/index.html');
      await page.locator('[data-tree-path="/Fixture/A.md"]').waitFor();
    };
    const row = (n) => page.locator('[data-tree-path="/Fixture/' + n + '"]');
    const banner = page.locator('#tree-trash-toast');
    const undo = banner.getByRole('button', { name: 'Undo' });
    const selected = () =>
      page
        .locator('#side-body [data-selected="true"]')
        .evaluateAll((a) => a.map((e) => e.dataset.treePath.split('/').pop()));
    const requests = (type) =>
      page.evaluate(
        (t) => trashTest.messages.filter((m) => m.type === t),
        type,
      );
    const trash = async (n) => {
      await row(n).click({ button: 'right' });
      await page
        .getByRole('menuitem', { name: 'Move to Trash', exact: true })
        .click();
      await banner.waitFor();
    };
    const diskHas = (n) =>
      page.evaluate((n) => trashTest.disk.has('/Fixture/' + n), n);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await start();
    const long = 'Z'.repeat(90) + '.md';
    await row(long).click({ button: 'right' });
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), [
      'New File',
      'New Folder',
      'Rename',
      'Move to Trash',
      'Reveal in Finder',
      'Copy Path',
    ]);
    assert.equal(
      await page
        .locator('#menu')
        .evaluate((el) => getComputedStyle(el).minWidth),
      '180px',
    );
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await banner.waitFor();
    const chip = await banner.evaluate((el) => {
      const name = el.querySelector('strong'),
        action = el.querySelector('button');
      return [
        el.offsetHeight,
        action.offsetHeight,
        name.title,
        name.scrollWidth > name.clientWidth,
        ...[...el.querySelectorAll('.trash-label > span')].map(
          (n) => n.scrollWidth === n.clientWidth,
        ),
      ];
    });
    assert.deepEqual(chip, [34, 20, long, true, true, true]);
    await undo.click();
    await row(long).waitFor();
    await row('A.md').click();
    await row('C.md').click({ modifiers: ['Meta'] });
    await row('E.md').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selected(), ['A.md', 'C.md', 'D.md', 'E.md']);
    await row('D.md').click({ button: 'right' });
    assert.deepEqual(await page.getByRole('menuitem').allTextContents(), [
      'Move to Trash',
    ]);
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await banner.waitFor();
    assert.equal(
      await banner.locator('.trash-label').textContent(),
      'Moved 4 items to Trash',
    );
    assert.equal(await row('A.md').count(), 0);
    assert.equal(await page.getByRole('tab').count(), 0);
    assert.equal(await diskHas('A.md'), true);
    await undo.click();
    await row('A.md').waitFor();
    assert.equal((await requests('trashBatch')).length, 0);
    assert.equal(await page.getByRole('tab').count(), 0);
    await page.evaluate(() => hostEvent('command', 'reopenTab'));
    assert.equal(await page.getByRole('tab').count(), 0);

    await row('B.md').click({ modifiers: ['Meta'] });
    await row('F.md').click({ modifiers: ['Shift'] });
    assert.deepEqual(await selected(), [
      'B.md',
      'C.md',
      'D.md',
      'E.md',
      'F.md',
    ]);
    await row('F.md').press('Backspace');
    assert.equal(await banner.locator('strong').innerText(), '5 items');
    await page.waitForTimeout(3150);
    assert.equal((await requests('trashBatch')).length, 0);
    await page.waitForFunction(() =>
      trashTest.messages.some((m) => m.type === 'trashBatch'),
    );
    const five = (await requests('trashBatch'))[0],
      stage = (await requests('stageTrash')).at(-1);
    assert.ok(five.at - stage.at >= 4950);
    await row('Folder').click();
    await row('Folder/Child.md').click();
    await trash('Folder');
    assert.equal(await diskHas('Folder/Child.md'), true);
    await page.waitForFunction(
      () => !trashTest.disk.has('/Fixture/Folder/Child.md'),
    );
    const folder = (await requests('trashBatch')).at(-1),
      staged = (await requests('stageTrash')).at(-1);
    assert.ok(folder.at - staged.at >= 2950);
    await page.waitForFunction(() => !document.querySelector('[role=tab]'));

    await start();
    await trash('A.md');
    await trash('B.md');
    assert.equal(await diskHas('A.md'), false);
    assert.equal(await diskHas('B.md'), true);
    await undo.click();
    await row('B.md').waitFor();
    await trash('C.md');
    await page.evaluate(() =>
      hostEvent('flush', { id: 'closing', reason: 'close' }),
    );
    await row('C.md').waitFor();
    await page.waitForFunction(() =>
      trashTest.messages.some(
        (m) => m.type === 'flushed' && m.id === 'closing' && m.ok,
      ),
    );
    assert.equal(await diskHas('C.md'), true);
    await page.evaluate(() => {
      trashTest.holdReceipt = true;
      trashTest.denyTrash = '/Fixture/D.md';
    });
    await row('C.md').click({ modifiers: ['Meta'] });
    await row('D.md').click({ modifiers: ['Meta'] });
    await trash('C.md');
    await page.waitForFunction(() => typeof trashTest.release === 'function');
    await page.evaluate(() =>
      hostEvent('flush', { id: 'wait', reason: 'quit' }),
    );
    assert.equal(
      (await requests('flushed')).some((m) => m.id === 'wait'),
      false,
    );
    await page.evaluate(() => trashTest.release());
    await row('D.md').waitFor();
    await page.waitForFunction(() =>
      trashTest.messages.some(
        (m) => m.type === 'flushed' && m.id === 'wait' && m.ok,
      ),
    );
    assert.equal(await diskHas('C.md'), false);
    assert.equal(await diskHas('D.md'), true);
    assert.match(await page.locator('#toast').innerText(), /Could not trash/);

    await start();
    await row('B.md').click();
    const tabB = page.getByRole('tab', { name: 'B', exact: true });
    await tabB.waitFor();
    await row('E.md').click({ modifiers: ['Meta'] });
    assert.deepEqual(await selected(), ['B.md', 'E.md']);
    const tabA = page.getByRole('tab', { name: 'A', exact: true });
    await tabA.getByText('A', { exact: true }).click();
    assert.deepEqual(await selected(), ['A.md']);
    await tabB.getByRole('button', { name: 'Close B.md', exact: true }).click();
    await tabB.waitFor({ state: 'detached' });
    await page.evaluate(() => {
      trashTest.denySave = true;
    });
    await page.locator('.ProseMirror').click();
    await page.keyboard.insertText(' changed');
    await row('A.md').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('#toast')
        .textContent.includes('Save your changes'),
    );
    assert.equal(await row('A.md').count(), 1);
    assert.equal(await page.getByRole('tab').count(), 1);
    assert.equal((await requests('stageTrash')).length, 0);
    assert.equal((await requests('trashBatch')).length, 0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS workspace tree multi-select, range union, batch menu, Undo, 3/5 second grace, successive batches, folder descendant, dirty-file protection, close cancellation and partial result before quit',
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
