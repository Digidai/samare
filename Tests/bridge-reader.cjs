// End-to-end UI against the real Bridge and disposable files from bridge_test.py.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  let input = '';
  for await (const part of process.stdin) input += part;
  const files = JSON.parse(input);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 860 },
    });
    page.setDefaultTimeout(7000);
    await page.addInitScript(() => { delete Crypto.prototype.randomUUID; });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const alpha = files['Alpha.md'],
      beta = files['Beta.md'],
      gamma = files['Gamma.md'],
      table = files['Table.csv'];
    const navigation = (which) =>
      page.getByRole('button', { name: 'Go to ' + which + ' document' });
    const find = page.getByRole('textbox', { name: 'Find in document' });
    const next = page.getByRole('button', { name: 'Next match' });
    async function count(text) {
      await page.waitForFunction(
        (expected) =>
          document.querySelector('#find output').textContent === expected,
        text,
      );
    }
    const editor = page.getByRole('textbox', { name: 'Markdown document' });
    await page.goto(alpha.url);
    await page.getByText('15 words · 64 characters', { exact: true }).waitFor();
    const openApp = page.getByRole('button', {name:'Open in Samare',exact:true});
    assert.equal(await openApp.innerText(), '');
    const hit = await openApp.boundingBox(), glyph = await openApp.locator('svg').boundingBox();
    assert.deepEqual([hit.width,hit.height,glyph.width,glyph.height], [28,28,15,15]);
    // The desktop handoff is exercised in a real Mac acceptance run. Avoid opening a
    // user's application from this unattended reader suite.
    const endpoint = alpha.url.replace('/d/', '/api/docs/') + '/open-in-app';
    await page.route(endpoint, r => r.fulfill({json:{opened:true}}));
    const [handoff] = await Promise.all([page.waitForRequest(endpoint),openApp.click()]);
    assert.equal(handoff.method(), 'POST');
    assert.deepEqual(handoff.postDataJSON(), {});
    assert.equal(page.url(), alpha.url);
    await page.unroute(endpoint);
    assert.ok(await navigation('previous').isDisabled());
    assert.ok(await navigation('next').isDisabled());
    const edge = page.getByRole('button', { name: 'Open document inspector' });
    await edge.hover();
    const inspector = page.getByRole('complementary', {
      name: 'Document inspector',
    });
    await inspector.getByText('Alpha.md').waitFor();
    await inspector.getByText('15 words').waitFor();
    await inspector.getByText('2 headings').waitFor();
    assert.equal((await inspector.boundingBox()).width, 300);
    await inspector.getByRole('button', { name: 'Second' }).click();
    await page.mouse.move(20, 300);
    await inspector.waitFor({ state: 'hidden' });
    await page.keyboard.press('Meta+f');
    await find.fill('alpha');
    await count('1 of 4');
    await find.press('Enter');
    await count('2 of 4');
    await find.press('Shift+Enter');
    await count('1 of 4');
    await page.getByRole('button', { name: 'Match case' }).click();
    await count('1 of 1');
    await find.press('Escape');
    await find.waitFor({ state: 'hidden' });
    await page.keyboard.press('Meta+f');
    assert.equal(await find.inputValue(), 'alpha');
    assert.equal(
      await page
        .getByRole('button', { name: 'Match case' })
        .getAttribute('aria-pressed'),
      'true',
    );
    await find.fill('missing term');
    await count('No matches');
    assert.ok(await next.isDisabled());
    await find.press('Escape');
    await editor.getByText('Alpha alpha ALPHA.', { exact: false }).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Additional.');
    await editor.locator('[data-wiki=true]').click();
    await page.waitForURL(beta.url);
    await editor.getByRole('heading', { name: 'Beta Study' }).waitFor();
    assert.match(await fs.readFile(alpha.path, 'utf8'), /Additional\./);
    await edge.hover();
    await inspector.getByRole('button', { name: 'Destination' }).click();
    await page.waitForFunction(() => window.scrollY > 1000);
    await navigation('previous').click();
    await page.waitForURL(alpha.url);
    await navigation('next').click();
    await page.waitForURL(beta.url);
    await page.goBack();
    await page.waitForURL(alpha.url);
    await page.reload();
    assert.ok(await navigation('next').isEnabled());
    const original = await fs.readFile(alpha.path, 'utf8');
    await fs.writeFile(
      alpha.path,
      original + '\n[New branch](' + gamma.url + ')\n',
    );
    await editor
      .getByText('New branch', { exact: true })
      .click({ modifiers: ['Meta'] });
    await page.waitForURL(gamma.url);
    await editor.getByRole('heading', { name: 'Gamma Study' }).waitFor();
    assert.ok(await navigation('next').isDisabled());
    await navigation('previous').click();
    await page.waitForURL(alpha.url);
    const separate = await browser.newPage();
    await separate.goto(gamma.url);
    assert.ok(
      await separate
        .getByRole('button', { name: 'Go to previous document' })
        .isDisabled(),
    );
    await separate.close();

    await page.goto(table.url);
    await page
      .getByRole('textbox', { name: 'Row 1, Task', exact: true })
      .waitFor();
    assert.ok(!(await edge.isVisible()));
    assert.ok(!(await page.locator('#word-count').isVisible()));
    await page.keyboard.press('Meta+f');
    await find.fill('Task 291');
    await count('1 of 1');
    const target = page.getByRole('textbox', {
      name: 'Row 291, Task',
      exact: true,
    });
    await target.waitFor();
    assert.equal(await target.inputValue(), 'Task 291');
    assert.equal(
      await page.evaluate(() =>
        document.activeElement.getAttribute('aria-label'),
      ),
      'Find in document',
    );
    await find.fill('echo');
    await count('1 of 301');
    await find.press('Shift+Enter');
    await count('301 of 301');
    await page
      .getByRole('textbox', { name: 'Row 301, Owner', exact: true })
      .waitFor();
    await find.fill('Task 1');
    await count('1 of 111');
    await find.press('Escape');
    assert.equal(
      await fs.readFile(table.path, 'utf8'),
      'Task,Owner\n' +
        Array.from(
          { length: 301 },
          (_, i) =>
            'Task ' +
            (i + 1) +
            ',Echo' +
            (i === 290 ? ' echo eCHO' : '') +
            '\n',
        ).join(''),
    );
    for (const [file, term] of [
      ['Long.md', 'distant needle'],
      ['Large source.md', '[needle]'],
    ]) {
      await page.goto(files[file].url);
      await page.locator('#word-count:not([hidden])').waitFor();
      await page.keyboard.press('Meta+f');
      await find.fill(term);
      await count('1 of 1');
      await page.waitForFunction(
        () =>
          window.scrollY > 1000 ||
          document.querySelector('textarea.de-source')?.scrollTop > 1000,
      );
      await find.press('Escape');
    }
    assert.deepEqual(errors, []);
    console.log(
      'Browser reader passed: isolated document history, clean navigation after editing, live stats, outline, retained find, whole-table search and disk bytes.',
    );
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
