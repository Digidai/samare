// Receives a real URL for a disposable file from bridge_test.py on stdin.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function waitForDisk(file, text) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if ((await fs.readFile(file, 'utf8')).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Expected browser edit did not reach the fixture file');
}

async function main() {
  let input = '';
  for await (const part of process.stdin) input += part;
  const { url, file } = JSON.parse(input);
  const folder = path.dirname(file);
  const moved = file + '.moved';
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async text => { window.fixtureCopy = text; } },
      });
    });
    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST') writes++; });
    await page.goto(url);
    const editor = page.getByRole('textbox', { name: 'Markdown document' });
    const relativePath = path.basename(folder) + '/' + path.basename(file);
    await editor.getByText('Fixture paragraph.').waitFor();
    for (const label of ['Copy file path', 'Copy file path: ' + relativePath]) {
      await page.evaluate(() => { window.fixtureCopy = null; });
      await page.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await page.evaluate(() => window.fixtureCopy), relativePath);
    }
    await fs.chmod(file, 0o444);
    await fs.chmod(folder, 0o555);
    await editor.getByText('Fixture paragraph.').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Retained draft.');
    const retry = page.getByRole('button', { name: 'Try again' });
    await retry.waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), '# Synthetic\n\nFixture paragraph.\n');
    const paused = writes;
    await page.waitForTimeout(2000);
    assert.equal(writes, paused);
    await fs.chmod(folder, 0o700);
    await fs.chmod(file, 0o600);
    await retry.click();
    await waitForDisk(file, 'Retained draft.');

    await fs.rename(file, moved);
    await page.getByText('The file was removed.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Dismiss' }).click();
    await editor.getByText('Fixture paragraph. Retained draft.').click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Edit while missing.');
    await page.waitForTimeout(1000);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    await fs.rename(moved, file);
    await waitForDisk(file, 'Edit while missing.');
    await fs.writeFile(file, '# Synthetic\n\nUpdated externally.\n');
    await editor.getByText('Updated externally.').waitFor();
    await page.close();
    const reopened = await browser.newPage();
    await reopened.goto(url);
    await reopened.getByText('Updated externally.').waitFor();
    await reopened.close();
    await fs.rename(file, moved);
    const unavailable = await browser.newPage();
    await unavailable.goto(url);
    await unavailable.getByRole('heading', { name: 'This document was moved or deleted' }).waitFor();
    await fs.rename(moved, file);
    await unavailable.getByRole('button', { name: 'Retry', exact: true }).click();
    await unavailable.getByRole('textbox').getByText('Updated externally.').waitFor();
  } finally {
    await fs.chmod(folder, 0o700);
    await fs.rename(moved, file).catch(() => {});
    await browser.close();
  }
}

main().catch(error => {
  console.error(String(error).replace(/https?:\/\/[^\s"']+/g, '[document URL]'));
  process.exitCode = 1;
});
