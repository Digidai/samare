// Drive both real find bars with an unhydrated 1.7 MB note. Use independent Chrome documents.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const { url, file } = JSON.parse(input);
  const text = await fs.readFile(file, 'utf8');
  assert.ok(Buffer.byteLength(text) > 1_700_000);
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const desktop of [false, true]) {
      const page = await browser.newPage({
        viewport: { width: 1024, height: 760 },
      });
      page.setDefaultTimeout(45000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      if (desktop) {
        const folder = path.resolve(__dirname, '../Resources');
        await page.route('http://reader-fixture.test/**', (route) => {
          const asset = path.resolve(
            folder,
            '.' + new URL(route.request().url()).pathname,
          );
          return asset.startsWith(folder + path.sep)
            ? route.fulfill({ path: asset })
            : route.abort();
        });
        await page.addInitScript((text) => {
          window.webkit = {
            messageHandlers: {
              host: {
                postMessage(m) {
                  if (m.type === 'ready')
                    setTimeout(
                      () =>
                        hostEvent('bootstrap', {
                          workspaces: [],
                          activeWorkspace: '',
                          activePath: '/Fixture.md',
                          files: [
                            { path: '/Fixture.md', name: 'Fixture.md', text },
                          ],
                          settings: {},
                        }),
                      0,
                    );
                },
              },
            },
          };
        }, text);
      }
      await page.addInitScript(() => {
        window.searchEvents = [];
        window.beats = [];
        window.longest = [];
        window.addEventListener(
          'keydown',
          (event) => {
            if (
              event.key === 'Escape' &&
              event.target.matches('#find input,#findbar input')
            )
              window.cancelledCount = event.target
                .closest('#find,#findbar')
                .querySelector('output').textContent;
          },
          true,
        );
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            if (searchEvents.length && e.startTime >= searchEvents[0].at)
              longest.push([
                Math.round(e.startTime - searchEvents[0].at),
                Math.round(e.duration),
                +document.querySelector('.de-root')?.dataset.hydratedFraction,
              ]);
        }).observe({ type: 'longtask', buffered: true });
        let prev = performance.now();
        setInterval(() => {
          const t = performance.now();
          if (window.searchEvents.length) window.beats.push(t - prev);
          prev = t;
        }, 16);
        window.addEventListener(
          'input',
          (e) => {
            if (e.target.matches('#find input,#findbar input'))
              window.searchEvents.push({
                value: e.target.value,
                at: performance.now(),
                fraction: Number(
                  document.querySelector('.de-root')?.dataset.hydratedFraction,
                ),
              });
          },
          true,
        );
      });
      const bar = desktop ? '#findbar' : '#find',
        selected = desktop ? 'find-current' : 'reader-current';
      await page.goto(desktop ? 'http://reader-fixture.test/index.html' : url, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('.de-root[data-long-doc] .ProseMirror').waitFor();
      await page.keyboard.press('Meta+f');
      await page.keyboard.insertText('common');
      await page.keyboard.press('Escape');
      assert.ok(await page.locator(bar).isHidden());
      assert.match(await page.evaluate(() => window.cancelledCount), /…$/);
      await page.keyboard.press('Meta+f');
      await page.locator(bar + ' input').fill('absent intermediate');
      await page.locator(bar + ' input').fill('unique formatted needle');
      await page.waitForFunction(
        ({ bar, selected }) => {
          const active = CSS.highlights.get(selected);
          return (
            document.querySelector(bar + ' output').textContent === '1 of 1' &&
            active &&
            [...active][0]?.toString() === 'unique formatted needle'
          );
        },
        { bar, selected },
      );
      const stats = await page.evaluate(
        ({ bar, selected }) => {
          const times = beats.slice().sort((a, b) => a - b),
            range = [...CSS.highlights.get(selected)][0];
          const rect = range.getBoundingClientRect();
          return {
            firstFraction: searchEvents[0]?.fraction,
            finalFraction: searchEvents.at(-1)?.fraction,
            inputs: searchEvents.map((x) => [
              x.value,
              Math.round(x.at - searchEvents[0].at),
            ]),
            longest,
            beats: times.length,
            max: Math.round(times.at(-1)),
            p95: Math.round(times[Math.floor(times.length * 0.95)]),
            elapsed: Math.round(performance.now() - searchEvents[0].at),
            visual: rect.bottom >= 0 && rect.top < innerHeight,
            focused:
              document.activeElement === document.querySelector(bar + ' input'),
          };
        },
        { bar, selected },
      );
      console.log(
        (desktop ? 'Mac shell' : 'Bridge') +
          ' progressive find ' +
          JSON.stringify(stats),
      );
      assert.ok(stats.firstFraction < 1 && stats.finalFraction < 1);
      assert.ok(stats.beats >= 3 && stats.visual && stats.focused);
      // Replace the note while a second query is still scanning an unhydrated
      // model. Neither a stale count nor a late scroll may leak into the new note.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.de-root[data-long-doc] .ProseMirror').waitFor();
      await page.keyboard.press('Meta+f');
      await page.locator(bar + ' input').fill('unique formatted needle');
      const updated = text.replace(
        'unique **formatted** needle',
        'replacement **formatted** hit',
      );
      if (desktop) {
        await page.evaluate(
          (value) =>
            hostEvent('externalChange', { path: '/Fixture.md', text: value }),
          updated,
        );
      } else {
        await fs.writeFile(file, updated);
        await page.evaluate(() => dispatchEvent(new Event('focus')));
      }
      await page.waitForFunction(
        (bar) =>
          document.querySelector(bar + ' output').textContent === 'No matches',
        bar,
      );
      await page.locator(bar + ' input').fill('replacement formatted hit');
      await page.waitForFunction(
        (key) =>
          [...(CSS.highlights.get(key) || [])][0]?.toString() ===
          'replacement formatted hit',
        selected,
      );
      await page.keyboard.press('Escape');
      assert.equal(
        await page.evaluate((key) => CSS.highlights.has(key), selected),
        false,
      );
      if (!desktop) await fs.writeFile(file, text);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
