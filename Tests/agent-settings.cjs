// Agent settings and linked-document browser round trip. All writable state is temporary.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const exec = promisify(execFile);
const root = path.resolve(__dirname, '..');
const resources = path.join(root, 'Resources');
const program = path.join(root, 'Bridge', 'samare');

async function browserRoundTrip(browser, cli, docPath) {
  const initial = '# Agent fixture\r\n\r\nOriginal on disk.\r\n';
  await fs.writeFile(docPath, initial);
  const link = await cli('url', docPath);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(link);
    const editor = page.getByRole('textbox', { name: 'Markdown document' });
    await editor.getByRole('heading', { name: 'Agent fixture' }).waitFor();
    const paragraph = editor.getByText('Original on disk.', { exact: true });
    await paragraph.click();
    await page.keyboard.press('End');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.startsWith('/api/') &&
        response.status() === 200,
    );
    await page.keyboard.insertText(' Edited from the browser.');
    await saved;
    const expected = initial.replace(
      'Original on disk.',
      'Original on disk. Edited from the browser.',
    );
    assert.equal(await fs.readFile(docPath, 'utf8'), expected);
    await fs.writeFile(docPath, expected + '\r\nExternal edit.\r\n');
    await editor.getByText('External edit.', { exact: true }).waitFor();
    await page.reload();
    await page
      .getByRole('textbox', { name: 'Markdown document' })
      .getByText('External edit.', { exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function agentSettings(browser, cli, clientHome) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 860 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  page.setDefaultTimeout(6000);
  const capture = async (name) => {
    const folder = process.env.AGENT_SETTINGS_SCREENSHOT_DIR;
    if (!folder) return;
    await fs.mkdir(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, name + '.png') });
  };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.fixtureMessages = [];
    window.webkit = {
      messageHandlers: {
        host: {
          postMessage(message) {
            window.fixtureMessages.push(message);
            if (message.type === 'ready') {
              queueMicrotask(() =>
                window.hostEvent('bootstrap', {
                  workspaces: [],
                  files: [],
                  settings: {},
                  activePath: '',
                }),
              );
            }
          },
        },
      },
    };
  });
  await page.route('http://samare-fixture.test/**', (route) => {
    const relative = decodeURIComponent(
      new URL(route.request().url()).pathname,
    );
    const asset = path.resolve(resources, '.' + relative);
    return asset.startsWith(resources + path.sep)
      ? route.fulfill({ path: asset })
      : route.abort();
  });
  // Only postMessage crosses the native boundary. The clipboard stays private to this fixture.
  const send = (event, value) =>
    page.evaluate(
      ([event, value]) => window.hostEvent(event, value),
      [event, value],
    );
  const snapshot = async (overrides = {}) => ({
    ...JSON.parse(await cli('doctor', '--json')),
    ...overrides,
  });
  const status = (value) => send('bridgeStatus', value);
  const nextMessage = async (type, action) => {
    const begin = await page.evaluate(() => window.fixtureMessages.length);
    await action();
    await page.waitForFunction(
      ([type, begin]) =>
        window.fixtureMessages.slice(begin).some((m) => m.type === type),
      [type, begin],
    );
    const matching = await page.evaluate(
      ([type, begin]) =>
        window.fixtureMessages.slice(begin).filter((m) => m.type === type),
      [type, begin],
    );
    assert.equal(
      matching.length,
      1,
      'Expected exactly one native ' + type + ' action',
    );
    return matching[0];
  };
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  try {
    await page.goto('http://samare-fixture.test/index.html');
    await nextMessage('bridgeStatus', () =>
      page.keyboard.press('Meta+,'),
    );
    await status(await snapshot());
    await dialog.waitFor();
    const names = { codex: 'Codex', claude: 'Claude Code', cursor: 'Cursor' };
    const labels = {
      ready: 'installed',
      fallback: 'using fallback',
      actionNeeded: 'needs setup',
      waiting: 'waiting',
      notDetected: 'not detected',
      repairRequired: 'needs repair',
      notInstalled: 'not installed',
      disabled: 'available after setup',
    };
    const clientIcon = (id, state) =>
      dialog.getByRole('img', {
        name: names[id] + ' ' + labels[state],
        exact: true,
      });
    for (const id of Object.keys(names)) {
      await cli('install-skill', id);
      const skill = path.join(
        clientHome,
        '.' + id,
        'skills',
        'samare',
        'SKILL.md',
      );
      assert.match(await fs.readFile(skill, 'utf8'), /samare/);
      const installed = await snapshot();
      assert.equal(installed.clients[id], true);
      await status(installed);
      await clientIcon(id, 'ready').waitFor();
    }
    await dialog
      .getByText('Already have an agent session running?', { exact: true })
      .waitFor();
    const summary = dialog.getByText('Already have an agent session running?', {
      exact: true,
    });
    const copySession = () =>
      dialog.getByRole('button', {
        name: 'Copy instructions for a running session',
        exact: true,
      });
    const acknowledge = (m, ok = true) => {
      assert.ok(
        m.requestId,
        'Copy requests should be individually acknowledged',
      );
      return send('copyResult', { requestId: m.requestId, ok });
    };
    assert.equal(await copySession().isVisible(), false);
    await capture('ready-collapsed');
    await summary.click();
    await page.evaluate(() => document.fonts.ready);
    if (process.env.WRITE_AGENT_EVIDENCE === '1') {
      await dialog.screenshot({
        path: path.join(root, 'Evidence', 'agent-setup.png'),
      });
    }
    const copied = await nextMessage('copy', () => copySession().click());
    const feedback = () =>
      dialog.getByRole('button', {
        name: 'Agent instructions copied',
        exact: true,
      });
    assert.equal(
      await feedback().isVisible(),
      false,
      'Clipboard success waits for the native reply',
    );
    await acknowledge(copied, false);
    assert.equal(
      await feedback().isVisible(),
      false,
      'Failed clipboard writes should not show success',
    );
    const accepted = await nextMessage('copy', () => copySession().click());
    assert.notEqual(accepted.requestId, copied.requestId);
    await acknowledge(copied);
    assert.equal(
      await feedback().isVisible(),
      false,
      'A stale acknowledgement cannot complete a later request',
    );
    await acknowledge(accepted);
    const fullSessionText = accepted.text;
    assert.equal(fullSessionText, copied.text);
    assert.match(fullSessionText, /Samare/i);
    assert.match(fullSessionText, /samare[^\n]*\burl\b/);
    assert.match(fullSessionText, /samare[^\n]*\bdoctor\b/);
    for (const part of [
      /absolute[- ]path/i,
      /exact/i,
      /one|once|single|at most/i,
      /internal/i,
      /sandbox/i,
      /retry|try again/i,
    ]) {
      assert.match(fullSessionText, part);
    }
    const normalize = (text) => text.replace(/\s+/g, ' ').trim();
    const visibleText = async () => normalize(await dialog.innerText());
    assert.ok(
      (await visibleText()).includes(normalize(fullSessionText)),
      'The entire copied prompt must be visible',
    );
    await feedback().waitFor();
    await capture('ready-copied');
    assert.equal(
      await dialog
        .getByRole('region', { name: 'Already have an agent session running?' })
        .locator('pre')
        .textContent(),
      fullSessionText,
    );
    await status(await snapshot());
    await send('defaultStatus', { isDefault: false, installedInApplications: false, name: 'TextEdit' });
    await dialog.getByText('Install Samare in Applications to change this setting.').waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Make Samare Default' }).count(), 0);
    await send('defaultStatus', { isDefault: false, installedInApplications: true, name: 'TextEdit' });
    await nextMessage('setDefault', () => dialog.getByRole('button', { name: 'Make Samare Default' }).click());
    await send('defaultStatus', {installedInApplications:true, pending:true});
    assert.ok(await dialog.getByRole('button', {name:'Making Samare Default…'}).isDisabled());
    await send('defaultStatus', {installedInApplications:true, error:'macOS kept the current default app. Select Try Again to request the change.'});
    await nextMessage('setDefault', () => dialog.getByRole('button', {name:'Try Again'}).click());
    await send('defaultStatus', {installedInApplications:true, isDefault:true});
    await dialog.getByRole('img', {name:'Samare is the default'}).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-default-action');
    await feedback().waitFor();
    assert.ok((await visibleText()).includes(normalize(fullSessionText)));
    await copySession().waitFor({ timeout: 4000 });
    assert.equal(await dialog.getByRole('tab').count(), 0);
    const linkHint = await nextMessage('copy', () =>
      dialog.getByText('send it this', { exact: true }).click(),
    );
    assert.match(linkHint.text, /127\.0\.0\.1/);
    assert.doesNotMatch(linkHint.text, /install-skill|deliverable/);
    assert.match(linkHint.text, /local-service (access|permission)|loopback/i);
    await acknowledge(linkHint);
    console.log(
      'PASS ready session prompt, entire text copied, refresh/feedback retention and separate connection instructions',
    );

    await cli('remove-skill', 'cursor');
    await assert.rejects(
      fs.access(
        path.join(clientHome, '.cursor', 'skills', 'samare', 'SKILL.md'),
      ),
      { code: 'ENOENT' },
    );
    const missing = await snapshot({ fallbackInstalled: false });
    assert.equal(missing.clients.cursor, false);
    // Reopening is the baseline for the default choice of the missing-skill panel.
    await page.keyboard.press('Escape');
    await status(missing);
    await page.keyboard.press('Meta+,');
    await dialog
      .getByText('Finish setting up your agent', { exact: true })
      .waitFor();
    const tab = (name) => dialog.getByRole('tab', { name, exact: true });
    assert.equal(
      await tab('Install skill').getAttribute('aria-selected'),
      'true',
    );
    const installCopy = dialog.getByRole('button', {
      name: 'Copy skill install instructions',
      exact: true,
    });
    await capture('missing-install');
    const install = await nextMessage('copy', () => installCopy.click());
    await acknowledge(install);
    for (const part of [
      /install-skill/,
      /codex/i,
      /claude/i,
      /cursor/i,
      /existing|already/i,
      /new.*(?:session|task)/i,
    ]) {
      assert.match(install.text, part);
    }
    assert.ok((await visibleText()).includes(normalize(install.text)));
    assert.equal(
      await dialog.getByRole('tabpanel').locator('pre').textContent(),
      install.text,
    );
    assert.notEqual(install.text, fullSessionText);
    await tab('Running session').click();
    assert.equal(
      await tab('Running session').getAttribute('aria-selected'),
      'true',
    );
    const otherTabCopy = await nextMessage('copy', () => copySession().click());
    assert.equal(otherTabCopy.text, fullSessionText);
    await acknowledge(otherTabCopy);
    await status(missing);
    assert.equal(
      await tab('Running session').getAttribute('aria-selected'),
      'true',
    );
    await feedback().waitFor();
    console.log(
      'PASS missing-skill setup, install and running-session tabs, native copy payloads',
    );

    const shared = path.join(
      clientHome,
      '.agents',
      'skills',
      'samare',
      'SKILL.md',
    );
    const cursor = path.join(
      clientHome,
      '.cursor',
      'skills',
      'samare',
      'SKILL.md',
    );
    await cli('install-skill', 'shared');
    await fs.mkdir(path.dirname(cursor), { recursive: true });
    await fs.symlink(shared, cursor);
    const fallback = await snapshot();
    assert.equal(fallback.clientDetails.cursor.usingFallback, true);
    assert.equal(fallback.clientDetails.cursor.status, 'current');
    await status(fallback);
    await clientIcon('cursor', 'fallback').waitFor();
    await dialog
      .getByRole('button', {
        name: 'Already have an agent session running?',
        exact: true,
      })
      .waitFor();
    assert.equal(await dialog.getByRole('tab').count(), 0);

    const userFile = path.join(clientHome, 'user-custom-skill.md');
    const customText =
      'This skill is maintained by the user. Preserve this content.\n';
    await fs.writeFile(userFile, customText);
    await fs.unlink(cursor);
    await fs.symlink(userFile, cursor);
    const customized = await snapshot();
    assert.equal(customized.clientDetails.cursor.status, 'modified');
    assert.equal(customized.clientDetails.cursor.usingFallback, false);
    await status(customized);
    await clientIcon('cursor', 'repairRequired').waitFor();
    await nextMessage('bridgeRepair', () =>
      dialog.getByRole('button', { name: 'Repair setup', exact: true }).click(),
    );
    await assert.rejects(cli('repair'), (error) =>
      /preserved/.test(error.stderr),
    );
    assert.equal(await fs.readFile(userFile, 'utf8'), customText);
    assert.equal(await fs.readlink(cursor), userFile);
    await cli('disable');
    const disabled = await snapshot();
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.clientDetails.cursor.status, 'modified');
    await status(disabled);
    for (const id of Object.keys(names))
      await clientIcon(id, 'disabled').waitFor();
    assert.equal(
      await dialog
        .getByRole('button', { name: 'Repair setup', exact: true })
        .count(),
      0,
    );
    assert.equal(await fs.readFile(userFile, 'utf8'), customText);
    console.log(
      'PASS real shared skill link, independent custom skill preserved on repair and disable',
    );
    const state = (patch, details) => ({
      ...missing,
      ...patch,
      clientDetails: { ...missing.clientDetails, ...details },
    });
    const allReady = {};
    for (const id of Object.keys(names))
      allReady[id] = { detected: true, installed: true, status: 'current' };
    await status(
      state(
        { enabled: true, commandStatus: 'current', commandInstalled: true },
        {
          codex: allReady.codex,
          claude: { detected: true, installed: false, status: 'outdated' },
          cursor: { detected: false, installed: false, status: 'missing' },
        },
      ),
    );
    await clientIcon('codex', 'ready').waitFor();
    await clientIcon('claude', 'repairRequired').waitFor();
    await clientIcon('cursor', 'notDetected').waitFor();
    await clientIcon('codex', 'ready').click();
    assert.equal(
      await page.evaluate(
        () =>
          window.fixtureMessages.filter((m) => m.type === 'bridgeClient')
            .length,
      ),
      0,
    );
    await clientIcon('cursor', 'notDetected').waitFor();
    const commandSummary = dialog.getByText(
      'Installed. Agents run it for you.',
      { exact: true },
    );
    await status(
      state(
        { commandInstalled: true, commandStatus: 'current', running: false },
        allReady,
      ),
    );
    await commandSummary.waitFor();
    await status(
      state(
        { commandInstalled: false, commandStatus: 'modified', running: true },
        allReady,
      ),
    );
    await dialog
      .getByText('The command needs repair.', { exact: true })
      .waitFor();
    await nextMessage('bridgeRepair', () =>
      dialog.getByRole('button', { name: 'Repair', exact: true }).click(),
    );
    await status(
      state(
        { commandInstalled: true, commandStatus: 'current', running: true },
        allReady,
      ),
    );
    const enable = dialog.getByRole('switch', {
      name: 'Disable Use in Agent',
      exact: true,
    });
    const off = await nextMessage('bridgeEnabled', () => enable.click());
    assert.equal(off.enabled, false);
    await status(state({ enabled: false, running: false }, allReady));
    await clientIcon('codex', 'disabled').waitFor();
    const on = await nextMessage('bridgeEnabled', () =>
      dialog
        .getByRole('switch', { name: 'Enable Use in Agent', exact: true })
        .click(),
    );
    assert.equal(on.enabled, true);
    await status(state({ enabled: true, background: false }, allReady));
    const bgOn = await nextMessage('bridgeAuto', () =>
      dialog
        .getByRole('switch', {
          name: 'Keep links working in the background',
          exact: true,
        })
        .click(),
    );
    assert.equal(bgOn.enabled, true);
    await status(state({ enabled: true, background: true }, allReady));
    const bgOff = await nextMessage('bridgeAuto', () =>
      dialog
        .getByRole('switch', { name: 'Turn off background links', exact: true })
        .click(),
    );
    assert.equal(bgOff.enabled, false);
    console.log(
      'PASS read-only client badges, independent client/command status, main and background native messages',
    );
    await page.keyboard.press('Escape');
    await status(
      state({ enabled: true, commandInstalled: true, running: true }, allReady),
    );
    const docPath = '/fixture/Share.md',
      original = 'Local draft.';
    await send('bootstrap', {
      workspaces: [{ path: '/fixture', name: 'fixture' }],
      activeWorkspace: '/fixture',
      files: [{ path: docPath, name: 'Share.md', text: original }],
      activePath: docPath,
      settings: { theme: 'dark' },
    });
    const rich = page.getByRole('textbox', { name: 'Markdown document' });
    await rich.click();
    await page.keyboard.press('End');
    const edited = original + ' Immediate edit.';
    const save = await nextMessage('save', async () => {
      await page.keyboard.insertText(' Immediate edit.');
      await page.keyboard.press('Meta+l');
    });
    assert.equal(save.path, docPath);
    assert.equal(save.text, edited);
    const links = () =>
      page.evaluate(() =>
        window.fixtureMessages.filter((m) => m.type === 'agentLink'),
      );
    assert.deepEqual(
      await links(),
      [],
      'A link must wait until this revision reaches disk',
    );
    await send('saved', { path: '/fixture/Other.md', text: edited });
    assert.deepEqual(
      await links(),
      [],
      'An unrelated file cannot release this pending link',
    );
    const request = await nextMessage('agentLink', () =>
      send('saved', { path: docPath, text: edited }),
    );
    assert.equal(request.path, docPath);
    const copiedLink = await nextMessage('copy', () =>
      send('agentLink', {
        path: docPath,
        url: 'http://127.0.0.1:12345/d/synthetic',
      }),
    );
    assert.equal(copiedLink.text, 'http://127.0.0.1:12345/d/synthetic');
    console.log(
      'PASS immediate edit + Command-L waits for the matching save receipt before generating the link',
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

async function run() {
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), 'samare-agent-settings-'),
  );
  const environment = {
    ...process.env,
    SAMARE_BRIDGE_HOME: path.join(temporary, 'state'),
    SAMARE_INTEGRATION_HOME: path.join(temporary, 'clients'),
    PYTHONDONTWRITEBYTECODE: '1',
    PATH: '/usr/bin:/bin',
  };
  const cli = async (...args) =>
    (
      await exec(process.env.PYTHON || 'python3', [program, ...args], {
        env: environment,
        timeout: 15000,
      })
    ).stdout.trim();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
    });
    await cli('enable');
    const launcher = path.join(
      environment.SAMARE_INTEGRATION_HOME,
      '.local',
      'bin',
      'samare',
    );
    const launcherCLI = async (...args) =>
      (
        await exec(launcher, args, { env: environment, timeout: 15000 })
      ).stdout.trim();
    await browserRoundTrip(
      browser,
      launcherCLI,
      path.join(temporary, 'Agent note (样本).md'),
    );
    console.log(
      'PASS real Bridge URL, browser edit, CRLF disk write, external edit and reopening',
    );
    await agentSettings(
      browser,
      cli,
      environment.SAMARE_INTEGRATION_HOME,
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await cli('stop');
      } finally {
        await fs.rm(temporary, { recursive: true, force: true });
      }
    }
  }
}

run().catch((error) => {
  // Browser traces may include the fixture's capability URL; keep it out of test output.
  console.error(
    String(error.stack || error).replace(
      /(https?:\/\/[^\s/]+\/(?:api|d)\/)[\w-]+/g,
      '$1[fixture]',
    ),
  );
  process.exitCode = 1;
});
