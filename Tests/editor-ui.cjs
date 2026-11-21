// Run with Playwright installed. CHROME_PATH may point at an existing headless Chromium.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'samare-editor-ui-'));
  const resources = path.resolve(__dirname, '../Resources');
  const fixture = path.join(dir, 'fixture.html');
  const url = (file) => pathToFileURL(path.join(resources, file)).href;
  fs.writeFileSync(
    fixture,
    '<!doctype html><meta charset=utf-8><link rel="stylesheet" href="' +
      url('editor.css') +
      '"><div id="editor"></div><script src="' +
      url('lib/diff.min.js') +
      '"></script><script src="' +
      url('merge.js') +
      '"></script><script src="' +
      url('vendor/editor-libs.js') +
      '"></script><script src="' +
      url('icons.js') +
      '"></script><script src="' +
      url('editor.js') +
      '"></script>',
  );
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
  });
  let passed = 0;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(fixture).href);
    const open = (name, text) =>
      page.evaluate(
        ([name, text]) => {
          window.ed?.destroy();
          window.changes = [];
          window.links = [];
          window.ed = SamareEditor.mount(document.querySelector('#editor'), {
            path: name,
            text,
            settings: { contentWidth: '100%' },
            onChange: (v) => changes.push(v),
            onOutline: (h) => {
              window.outline = h;
            },
            onLink: (v) => links.push(v),
            onNoteSearch: (q, cb) =>
              cb([{ name: 'Reference.md', path: '/notes/Reference.md' }]),
          });
        },
        [name, text],
      );
    const value = () => page.evaluate(() => ed.getText());
    const cmd = (key, arg) =>
      page.evaluate(([key, arg]) => ed.command(key, arg), [key, arg]);
    const check = async (title, run) => {
      await run();
      ++passed;
      console.log('ok', title);
    };
    const original =
      '\ufeff---\r\nstatus: Draft\r\ntags: [a, b]\r\n---\r\n\r\n# Heading\r\n\r\nType here.\r\n\r\n_Keep this_ and **this**.\r\n\r\n- [ ] Task\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n[wiki]: https://example.com\r\n';
    await check(
      'pristine CRLF/BOM, front matter, outline and mode changes',
      async () => {
        await open('/notes/A.md', original);
        assert.deepEqual(
          await page.evaluate(() => outline.map((h) => [h.level, h.text])),
          [[1, 'Heading']],
        );
        assert.ok(await page.locator('.ProseMirror').isVisible());
        assert.ok(
          await page
            .locator('.de-properties')
            .innerText()
            .then((s) => s.includes('Properties')),
        );
        await cmd('mode', 'preview');
        await cmd('mode', 'source');
        await cmd('mode', 'edit');
        assert.equal(await value(), original);
        assert.equal(await page.evaluate(() => changes.length), 0);
      },
    );
    await check(
      'rich editing preserves original formatting of untouched blocks',
      async () => {
        await page.locator('.ProseMirror > p').first().click();
        await page.keyboard.press('End');
        await page.keyboard.insertText(' 中文');
        assert.equal(
          await value(),
          original.replace('Type here.', 'Type here. 中文'),
        );
        await cmd('undo');
        assert.equal(await value(), original);
        await cmd('redo');
        assert.match(await value(), /中文/);
      },
    );
    await check(
      'task click, direct table edit and property update',
      async () => {
        await page.locator('.de-task').check();
        assert.match(await value(), /- \[x\] Task/);
        await page.locator('.ProseMirror td p').first().click();
        await page.keyboard.press('End');
        await page.keyboard.insertText('3');
        assert.match(await value(), /\| 13 \| 2 \|/);
        await cmd('properties');
        await page
          .getByRole('textbox', { name: 'status', exact: true })
          .fill('Done');
        await page
          .getByRole('textbox', { name: 'status', exact: true })
          .press('Tab');
        assert.match(await value(), /status: Done\r\n/);
        assert.match(await value(), /tags: \[a, b\]/);
      },
    );
    await check(
      'source editing, replace, external refresh and mode isolation',
      async () => {
        await cmd('mode', 'source');
        const txt = await page.locator('.de-source').inputValue();
        await page
          .locator('.de-source')
          .fill(txt.replace('Draft', 'Done').replace('Type here', 'New text'));
        assert.match(await value(), /\r\n/);
        assert.match(await value(), /New text/);
        await page.evaluate(() => ed.setText('Changed on disk\n'));
        assert.equal(await value(), 'Changed on disk\n');
        await cmd('mode', 'edit');
        assert.equal(
          await page.locator('.ProseMirror').innerText(),
          'Changed on disk',
        );
      },
    );
    await check('wiki completion and link activation', async () => {
      await open('/notes/A.md', '');
      await page.locator('.ProseMirror').click();
      await page.keyboard.type('[[Re');
      await page.getByRole('option', { name: 'Reference.md' }).waitFor();
      await page.keyboard.press('Enter');
      assert.equal(await value(), '[[Reference]]');
      await page.locator('.ProseMirror a').click();
      assert.deepEqual(await page.evaluate(() => links), ['Reference']);
    });
    await check(
      'code syntax, inline and display math, offline Mermaid',
      async () => {
        await open(
          '/notes/A.md',
          '# Drawing\n\nInline $x^2$.\n\n$$\na+b\n$$\n\n```js\nconst x = 1;\n```\n\n```mermaid\nflowchart LR\nA[Start] --> B[End]\n```\n',
        );
        await page.locator('.de-diagram svg').waitFor();
        assert.equal(await page.locator('.katex').count(), 2);
        assert.ok((await page.locator('.hljs-keyword').count()) > 0);
        await page
          .getByRole('button', { name: 'Source', exact: true })
          .last()
          .click();
        assert.ok(
          await page
            .locator('.de-codebox')
            .last()
            .locator('.de-pre')
            .isVisible(),
        );
      },
    );
    await check(
      'CSV quoting, embedded newline, untouched trailing CRLF and row addition',
      async () => {
        const csv =
          'Name,Value,Notes\r\n"a","a,b","line 1\r\nline 2"\r\n"b","007","ok"\r\n';
        await open('Example.csv', csv);
        assert.equal(await value(), csv);
        await page
          .locator('.de-grid tr')
          .nth(1)
          .locator('textarea')
          .nth(1)
          .fill('New "value", yes');
        assert.equal(await value(), csv);
        await page.keyboard.press('Enter');
        assert.equal(
          await value(),
          csv.replace('"a,b"', '"New ""value"", yes"'),
        );
        await page.getByRole('button', { name: 'New row' }).click();
        assert.match(await value(), /\r\n,,\r\n$/);
      },
    );
    await check(
      'TSV field edit leaves non-target records untouched',
      async () => {
        await open('Example.tsv', 'Name\tScore\nA\t1\n');
        await page
          .locator('.de-grid tr')
          .nth(1)
          .locator('textarea')
          .nth(1)
          .fill('2');
        await page.keyboard.press('Tab');
        assert.equal(await value(), 'Name\tScore\nA\t2\n');
      },
    );
    await check(
      'JSON source slices preserve 64-bit numbers, duplicate keys and formatting',
      async () => {
        const j =
          '{\n  "id": 9223372036854775807,\n  "same": "first", "same": "second", "nested": [true, false]\n}\n';
        await open('Example.json', j);
        await page
          .getByRole('textbox', { name: 'same', exact: true })
          .last()
          .fill('new');
        assert.equal(await value(), j.replace('"second"', '"new"'));
      },
    );
    await check('JSONL keeps record boundaries and blank lines', async () => {
      const j = '{"id":1,"name":"A"}\r\n\r\n{"id":2,"name":"B"}\r\n';
      await open('Records.jsonl', j);
      assert.deepEqual(
        await page.evaluate(() => {
          const list = document.querySelector('.de-json-log');
          const row = list.querySelector('.de-log-record summary');
          return [
            list.getBoundingClientRect().width,
            row.getBoundingClientRect().height,
          ];
        }),
        [880, 36],
      );
      assert.deepEqual(await page.locator('.de-log-number').allTextContents(), [
        '1',
        '2',
      ]);
      assert.equal(await page.locator('.de-log-record[open]').count(), 0);
      await page
        .getByRole('button', { name: 'Newest first', exact: true })
        .click();
      assert.deepEqual(await page.locator('.de-log-number').allTextContents(), [
        '2',
        '1',
      ]);
      await page.locator('.de-log-record summary').first().click();
      await page
        .getByRole('textbox', { name: 'name', exact: true })
        .first()
        .fill('C');
      assert.equal(await value(), j.replace('"B"', '"C"'));
      await page.getByRole('button', { name: 'New record' }).click();
      assert.match(await value(), /\r\n\{\}\r\n$/);
    });
    await check(
      'invalid structured source can be repaired without preemptive writes',
      async () => {
        await open('Broken.json', '{"oops":');
        assert.equal(await page.locator('.de-error').count(), 1);
        assert.equal(await page.evaluate(() => changes.length), 0);
        await page.getByRole('button', { name: 'Edit source' }).click();
        await page.locator('.de-source').fill('{"ok":true}');
        await cmd('mode', 'edit');
        assert.equal(
          await page
            .getByRole('switch', { name: 'ok', exact: true })
            .getAttribute('aria-checked'),
          'true',
        );
      },
    );
    await check('JSON comma repair changes one source byte, names the line and supports undo', async () => {
      const good = '\ufeff{\r\n  "n": 9223372036854775807,\r\n  "n": "punctuation , }"\r\n}\r\n';
      for (const [bad, label, line] of [
        [good.replace('7,','7'),'Add the comma','2'],
        [good.replace('}"\r\n','}",\r\n'),'Remove the comma','3'],
      ]) {
        await open('Report.json',bad);
        assert.equal(await page.locator('.de-json-excerpt [data-error] .de-json-line-number').textContent(),line);
        assert.deepEqual(await page.evaluate(() => changes),[]);
        await page.getByRole('button',{name:label}).click();
        assert.equal(await value(),good);
        await cmd('undo');
        assert.equal(await value(),bad);
      }
    });
    await check('JSONL follows appended records at the live end and keeps a reader in place elsewhere', async () => {
      const log = Array.from({length:120}, (_,n) => JSON.stringify({msg:'row ' + n})).join('\n') + '\n';
      const add = line => page.evaluate(line => ed.setText(ed.getText() + JSON.stringify({msg:line}) + '\n'),line);
      const metrics = () => page.evaluate(() => {
        const s = document.scrollingElement; return [s.scrollTop,s.scrollHeight-s.clientHeight];
      });
      await open('Today.jsonl',log);
      await page.evaluate(() => scrollTo(0,document.scrollingElement.scrollHeight));
      await add('tail');
      let [y,end] = await metrics();
      assert.ok(Math.abs(y-end)<3);
      await page.evaluate(() => scrollTo(0,370));
      await add('second');
      assert.equal((await metrics())[0],370);
      await page.getByRole('button',{name:'Show new records'}).click();
      [y,end]=await metrics(); assert.ok(Math.abs(y-end)<3);
      await page.getByRole('button',{name:'Newest first'}).click();
      await page.evaluate(() => scrollTo(0,0));
      await add('first');
      assert.equal((await metrics())[0],0);
      assert.match(await page.locator('.de-log-message').first().textContent(),/first/);
    });
    await check('inline formula previews, leaves on blur and scroll, keeps placement and undoes once', async () => {
      const raw = '# Equation\n\nBefore $x^2$ and after.\n\n' + 'A separate paragraph.\n\n'.repeat(60);
      await open('Formula.md', raw);
      const atom = page.locator('.de-inline-math').first();
      await atom.click();
      let field = page.getByRole('textbox',{name:'LaTeX source'});
      const a=await atom.boundingBox(), box=await page.getByRole('dialog',{name:'Edit formula'}).boundingBox();
      assert.ok(Math.abs(box.y - a.y - a.height - 8)<2);
      await field.fill('y_3');
      assert.equal(await atom.locator('annotation').textContent(),'y_3');
      assert.equal(await value(),raw);
      await page.locator('.ProseMirror h1').click();
      assert.equal(await value(),raw.replace('x^2','y_3'));
      await cmd('undo');
      assert.equal(await value(),raw);
      await atom.click(); await field.fill('z_4');
      await page.evaluate(() => scrollBy(0,200));
      await field.waitFor({state:'hidden'});
      assert.equal(await value(),raw.replace('x^2','z_4'));
      await atom.click(); await field.press('Escape');
      await page.keyboard.insertText('!');
      assert.match(await value(),/\$z_4\$! and after/);
      const latest = await value();
      await atom.click(); await field.fill('a^2');
      await page.evaluate(v=>ed.setText(v+'\nExternal paragraph.\n'),latest);
      assert.equal(await field.inputValue(),'a^2');
      await field.press('Enter');
      assert.equal(await value(),latest.replace('z_4','a^2')+'\nExternal paragraph.\n');
    });
    await check('scrolling away from an edited link or an open note picker closes the popover', async () => {
      const raw='Visit [old](https://example.com/old).\n\n'+('More reading.\n\n'.repeat(80));
      await open('Scrolling.md',raw);
      await page.locator('.ProseMirror a').click();
      const linkForm = page.getByRole('dialog',{name:'Edit link'});
      await linkForm.getByPlaceholder('URL or workspace path').fill('https://example.org/updated');
      await page.mouse.move(15,400); await page.mouse.wheel(0,300);
      await linkForm.waitFor({state:'hidden'});
      assert.ok((await value()).includes('https://example.org/updated'));
      // Start the picker at a visible caret on a fresh note. macOS End scrolls
      // the page and can dismiss the very picker this step intends to inspect.
      await open('Picker.md','Choose a note: '+('\n\nMore reading.'.repeat(80)));
      await page.evaluate(()=>window.scrollTo(0,0));
      const para=page.locator('.ProseMirror p').first();
      await para.click();
      await page.keyboard.press('Meta+ArrowRight'); await page.keyboard.insertText('[[Re');
      const picker=page.locator('.de-note-picker'); await picker.waitFor();
      await page.mouse.move(15,400); await page.mouse.wheel(0,350);
      await picker.waitFor({state:'hidden'});
    });
    await check('regular links edit both fields and keep an outside-click change in one undo step', async () => {
      const source='Visit [old](https://example.com/old).';
      await open('Links.md',source);
      await page.locator('.ProseMirror a').click();
      const form = page.getByRole('dialog',{name:'Edit link'});
      await form.getByPlaceholder('Link text').fill('new');
      await form.getByPlaceholder('URL or workspace path').fill('https://example.com/new');
      await page.locator('.ProseMirror').click({position:{x:2,y:2}});
      assert.equal(await value(),'Visit [new](https://example.com/new).');
      await cmd('undo'); assert.equal(await value(),source);
    });
    await check(
      'slash menu supports keyboard, search, cancellation and insertion',
      async () => {
        await open('/notes/A.md', '');
        await page.locator('.ProseMirror').click();
        await page.keyboard.type('/headi');
        await page.getByRole('listbox', { name: 'Insert block' }).waitFor();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Outline');
        assert.equal(await value(), '## Outline');
        await page.keyboard.press('Enter');
        await page.keyboard.type('/x');
        await page.keyboard.press('Backspace');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.de-slash').count(), 0);
        await page.keyboard.press('Backspace');
        await page.keyboard.type('/properties');
        await page.keyboard.press('Enter');
        assert.ok(
          await page
            .getByRole('button', { name: '+ Add property' })
            .isVisible(),
        );
      },
    );
    await check(
      'CJK punctuation emphasis, adjacent marked currency and escaped math',
      async () => {
        const s =
          '从**$19mn**到**$172mn**。增长了**（重点）**之后，行内 $x+y$ 与 \\\\$5。';
        await open('/notes/A.md', s);
        assert.deepEqual(
          await page.locator('.ProseMirror strong').allTextContents(),
          ['$19mn', '$172mn', '（重点）'],
        );
        assert.equal(await page.locator('.de-inline-math').count(), 1);
        assert.equal(await value(), s);
      },
    );
    await check(
      'preview and source remain visible together for SVG, Mermaid and math',
      async () => {
        const s =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="12" height="10"/></svg>\n\n<div>Hello</div>\n\n$$\nx+y\n$$';
        await open('/notes/A.md', s);
        assert.ok(await page.locator('.de-svg').isVisible());
        assert.ok(
          await page
            .locator('pre[data-kind=raw]')
            .innerText()
            .then((t) => t.includes('<div>Hello</div>')),
        );
        await page.locator('.de-svg').click();
        assert.ok(
          await page
            .locator('.de-codebox')
            .first()
            .locator('.de-pre')
            .isVisible(),
        );
        assert.ok(await page.locator('.de-svg').isVisible());
        await page.keyboard.press('Escape');
        assert.ok(
          await page
            .locator('.de-codebox')
            .first()
            .locator('.de-pre')
            .isHidden(),
        );
        assert.equal(await value(), s);
      },
    );
    await check(
      'CSV rectangular paste, row/column deletion and undo',
      async () => {
        await open('a.csv', 'A,B,C\r\n1,2,3\r\n4,5,6\r\n');
        await page
          .locator('.de-grid tr')
          .nth(1)
          .locator('textarea')
          .nth(1)
          .evaluate((f) => {
            const dt = new DataTransfer();
            dt.setData('text/plain', 'first\tsecond\nthird\tfourth');
            f.dispatchEvent(
              new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dt,
              }),
            );
          });
        assert.equal(
          await value(),
          'A,B,C\r\n1,first,second\r\n4,third,fourth\r\n',
        );
        await page
          .locator('.de-grid tr')
          .nth(1)
          .locator('textarea')
          .nth(1)
          .click({ button: 'right' });
        assert.equal(await page.getByRole('menu').count(), 0);
        await page.getByRole('button', {name:'Column B options'}).click({button:'right'});
        await page.getByRole('menuitemradio', { name: 'Delete column' }).click();
        assert.equal(await value(), 'A,C\r\n1,second\r\n4,fourth\r\n');
        await page.getByRole('button',{name:'Row 1 options'}).click();
        await page.getByRole('menuitem', { name: 'Delete row' }).click();
        assert.equal(await value(), 'A,C\r\n4,fourth\r\n');
        await cmd('undo');
        assert.match(await value(), /1,second/);
      },
    );
    await check('block formula, SVG and Mermaid open from their picture and leave with Done, Escape or outside click', async () => {
      const source = '# Blocks\n\n$$\nx^2\n$$\n\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>\n\n```mermaid\ngraph LR\nA-->B\n```\n';
      await open('Blocks.md',source);
      for (const box of await page.locator('.de-codebox').all()) {
        const picture = box.locator('.de-diagram');
        for (const way of ['Done','Escape','outside']) {
          await picture.click();
          assert.ok(await box.locator('.de-pre').isVisible());
          if (way === 'Done') await box.getByRole('button',{name:'Done'}).click();
          else if (way === 'Escape') await page.keyboard.press('Escape');
          else await page.locator('.ProseMirror h1').click();
          assert.ok(await box.locator('.de-pre').isHidden());
        }
      }
      assert.equal(await value(),source);
    });
    await check(
      'Held CSV cells commit once on Enter, Tab, blur or save; Escape cancels',
      async () => {
        const original = 'Title,Owner\r\n"First",Sam\r\nLast,Lee\r\n';
        await open('Draft.csv', original);
        const field = (row, name) =>
          page.getByRole('textbox', {
            name: 'Row ' + row + ', ' + name,
            exact: true,
          });
        const focus = () =>
          page.evaluate(() => [
            document.activeElement.closest('tr')?.dataset.row,
            document.activeElement.dataset.col,
          ]);
        await field(1, 'Title').fill('Discard me');
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(await value(), original);
        assert.deepEqual(await page.evaluate(() => changes), []);
        await page.keyboard.press('Escape');
        assert.deepEqual(await focus(), ['1', '0']);
        assert.equal(await field(1, 'Title').inputValue(), 'First');
        await page.keyboard.type('New');
        assert.equal(await field(1, 'Title').inputValue(), 'New');
        await page.keyboard.press('Enter');
        assert.deepEqual(await focus(), ['2', '0']);
        const first = original.replace('First', 'New');
        assert.deepEqual(await page.evaluate(() => changes), [first]);
        await field(2, 'Title').fill('Last');
        await page.keyboard.press('Shift+Tab');
        assert.deepEqual(await focus(), ['2', '0']);
        await field(1, 'Owner').fill('Alex');
        await page.keyboard.press('Tab');
        assert.deepEqual(await focus(), ['1', '1']);
        await field(2, 'Title').fill('Two');
        await page.keyboard.press('End');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.insertText('lines');
        const current = first.replace('Sam', 'Alex');
        assert.equal(await value(), current);
        await page.locator('.de-data-header h1').click();
        const multi = current.replace('Last', '"Two\nlines"');
        assert.equal(await value(), multi);
        await field(1, 'Owner').fill('Kai');
        await cmd('commitCell');
        await field(1, 'Owner').fill('Mia');
        await cmd('commitCell');
        assert.equal(await value(), multi.replace('Alex', 'Mia'));
        assert.equal(await page.evaluate(() => changes.length), 5);
        await cmd('undo');
        assert.equal(await value(), multi.replace('Alex', 'Kai'));
      },
    );
    await check(
      'External changes retain the current draft and follow an identifiable row and column',
      async () => {
        const original = 'Name,Qty\r\nOne,1\r\nTwo,2\r\n';
        const latest = 'Name,Qty\r\nZero,0\r\nOne,1\r\nTwo,2\r\n';
        const field = (row, name) =>
          page.getByRole('textbox', {
            name: 'Row ' + row + ', ' + name,
            exact: true,
          });
        const external = (s) => page.evaluate((s) => ed.setText(s), s);
        await open('External.csv', original);
        await field(2, 'Qty').fill('99');
        await external(latest);
        assert.equal(await field(3, 'Qty').inputValue(), '99');
        assert.equal(await value(), latest);
        await page.keyboard.press('Enter');
        assert.equal(await value(), latest.replace('Two,2', 'Two,99'));
        await field(2, 'Qty').fill('new');
        const reordered = 'Qty,Name\r\n0,Zero\r\n1,One\r\n99,Two\r\n';
        await external(reordered);
        assert.equal(await field(2, 'Qty').inputValue(), 'new');
        await external(reordered.replace('1,One', '42,One'));
        assert.equal(await field(2, 'Qty').inputValue(), 'new');
        await page.keyboard.press('Escape');
        assert.equal(await field(2, 'Qty').inputValue(), '42');
        assert.ok((await value()).includes('42,One'));
        await field(2, 'Qty').fill('55');
        await external(reordered.replace('1,One', '77,One'));
        await page.keyboard.press('Enter');
        assert.equal(await value(), reordered.replace('1,One', '55,One'));
      },
    );
    await check(
      'Equal-size replacements with a new ID or header retain a separate draft',
      async () => {
        const fixture = 'ID,Name,Status\n1,A,open\n2,B,closed\n',
          replacement = fixture.replace('2,B,closed', '3,C,closed');
        await open('Identity.csv', fixture);
        await page.getByRole('textbox', { name: 'Row 2, Name' }).fill('Local');
        await page.evaluate((v) => ed.setText(v), replacement);
        await cmd('commitCell');
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Recovered cell draft' })
            .inputValue(),
          'Local',
        );
        assert.equal(await value(), replacement);
        await page.getByRole('button', { name: 'Discard draft' }).click();
        await page
          .getByRole('textbox', { name: 'Row 2, Name' })
          .fill('Local name');
        const headers = replacement.replace(
          'ID,Name,Status',
          'ID,Color,Status',
        );
        await page.evaluate((v) => ed.setText(v), headers);
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Recovered cell draft' })
            .inputValue(),
          'Local name',
        );
        assert.equal(
          await page.getByRole('button', { name: 'Add as new row' }).count(),
          0,
        );
        assert.equal(await value(), headers);
        await page.getByRole('button', { name: 'Discard draft' }).click();
        await open('Scalar.csv', 'Value\nOld\n');
        await page.getByRole('textbox', { name: 'Row 1, Value' }).fill('Local');
        await page.evaluate(() => ed.setText('Value\nOther\n'));
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Recovered cell draft' })
            .inputValue(),
          'Local',
        );
        await page.getByRole('button', { name: 'Discard draft' }).click();
      },
    );
    await check(
      'A deleted row draft survives blur, save and reopening; only the explicit choice appends it',
      async () => {
        const initial = 'Name,Qty\r\nOne,1\r\n"Two",2\r\n',
          latest = 'Name,Qty\r\nOne,1\r\n';
        const orphan = page.getByRole('textbox', {
          name: 'Recovered cell draft',
        });
        const stage = async () => {
          await open('Deleted.csv', initial);
          await page.getByRole('textbox', { name: 'Row 2, Qty' }).fill('99');
          await page.evaluate((s) => ed.setText(s), latest);
          assert.equal(await orphan.inputValue(), '99');
        };
        await stage();
        await page.locator('.de-data-header h1').click();
        await cmd('commitCell');
        assert.equal(await value(), latest);
        assert.deepEqual(await page.evaluate(() => changes), []);
        await open('Other.csv', latest);
        assert.equal(await orphan.count(), 0);
        await open('Deleted.csv', latest);
        assert.equal(await orphan.inputValue(), '99');
        await page.getByRole('button', { name: 'Discard draft' }).click();
        assert.equal(await value(), latest);
        await stage();
        await page.getByRole('button', { name: 'Add as new row' }).click();
        assert.equal(await value(), latest + '"Two",99\r\n');
        assert.equal(await orphan.count(), 0);
        assert.equal(await page.evaluate(() => changes.length), 1);
        await cmd('undo');
        assert.equal(await value(), latest);
      },
    );
    await check(
      'CSV composition stays in the draft through candidate selection and merges a queued external change',
      async () => {
        const initial = 'Name,Owner\nOne,A\nTwo,B\n';
        const field = page.getByRole('textbox', {
          name: 'Row 1, Owner',
          exact: true,
        });
        await open('Composition.csv', initial);
        const input = await page.context().newCDPSession(page);
        await field.focus();
        await field.evaluate((n) => n.select());
        await input.send('Input.imeSetComposition', {
          text: '中',
          selectionStart: 1,
          selectionEnd: 1,
        });
        await page.evaluate(
          (s) => ed.setText(s),
          initial.replace('Two,B', 'Two,Remote'),
        );
        assert.equal(await value(), initial);
        await input.send('Input.insertText', { text: '中文' });
        assert.equal(await field.inputValue(), '中文');
        assert.equal(await page.evaluate(() => changes.length), 0);
        await page.keyboard.press('Enter');
        assert.equal(await value(), 'Name,Owner\nOne,中文\nTwo,Remote\n');
        assert.equal(await page.evaluate(() => changes.length), 1);
        await input.detach();
      },
    );
    await check(
      'CSV row menu inserts at the chosen data row and retains its original source bytes',
      async () => {
        const sample = '\ufeffName,Score\r\n"A\nA",01\r\n"B",2';
        await open('/notes/Inline.csv', sample);
        const rowButton = (n) =>
          page.getByRole('button', {
            name: 'Row ' + n + ' options',
            exact: true,
          });
        await rowButton(2).focus();
        await rowButton(2).press('Enter');
        const actions = page.getByRole('menuitem');
        assert.deepEqual(
          await actions.evaluateAll((nodes) =>
            nodes.map((n) => n.getAttribute('aria-label')),
          ),
          ['Insert row above', 'Insert row below', 'Delete row'],
        );
        await page
          .getByRole('menuitem', { name: 'Insert row above', exact: true })
          .click();
        assert.equal(
          await value(),
          '\ufeffName,Score\r\n"A\nA",01\r\n,\r\n"B",2',
        );
        await cmd('undo');
        assert.equal(await value(), sample);
        await rowButton(2).click();
        await page
          .getByRole('menuitem', { name: 'Insert row below', exact: true })
          .click();
        assert.equal(await value(), sample + '\r\n,');
        await cmd('undo');
        assert.equal(await value(), sample);
        await rowButton(1).click();
        await page
          .getByRole('menuitem', { name: 'Delete row', exact: true })
          .click();
        assert.equal(await value(), '\ufeffName,Score\r\n"B",2');
        await cmd('undo');
        assert.equal(await value(), sample);
        await cmd('mode', 'preview');
        assert.equal(
          await page.getByRole('button', { name: /Row .* options/ }).count(),
          0,
        );
      },
    );
    await check(
      'selected TSV row shortcuts stay in the same column and cross pagination',
      async () => {
        const s =
          'A\tB\n' +
          Array.from({ length: 202 }, (_, i) => String(i + 1) + '\ttext').join(
            '\n',
          );
        await open('/notes/Large.tsv', s);
        const last = page.getByRole('textbox', {
          name: 'Row 200, B',
          exact: true,
        });
        await last.focus();
        await last.press('Escape');
        await page.keyboard.press('Meta+Enter');
        assert.equal(await value(), s.replace('201\ttext', '\t\n201\ttext'));
        const focus = () =>
          page.evaluate(() => [
            document.activeElement.closest('tr')?.dataset.row,
            document.activeElement.dataset.col,
          ]);
        assert.deepEqual(await focus(), ['201', '1']);
        await page.keyboard.press('Meta+Shift+Enter');
        assert.deepEqual(await focus(), ['201', '1']);
        assert.equal(
          await value(),
          s.replace('201\ttext', '\t\n\t\n201\ttext'),
        );
        await page.keyboard.press('Meta+Backspace');
        assert.equal(await value(), s.replace('201\ttext', '\t\n201\ttext'));
        await page.keyboard.press('Enter');
        assert.equal(
          await page.evaluate(() =>
            document.activeElement.getAttribute('aria-label'),
          ),
          'Row 201, B',
        );
        await open('/notes/One.csv', 'Item\r\nOnly\r\n');
        await page.getByRole('button', { name: 'Row 1 options' }).click();
        await page.getByRole('menuitem', { name: 'Insert row below' }).click();
        assert.equal(await value(), 'Item\r\nOnly\r\n""\r\n');
      },
    );
    const column = (letter) =>
      page.getByRole('button', {
        name: 'Column ' + letter + ' options',
        exact: true,
      });
    const columnItem = (name) =>
      page.getByRole('menuitemradio', { name, exact: true });
    const selectColumnOption = async (letter, name) => {
      await column(letter).click();
      await columnItem(name).click();
    };
    await check(
      'CSV header commands, keyboard selection, inline rename and lossless undo',
      async () => {
        const raw = '\ufeffID,"中文",Status\r\n01,"a,b",yes\r\n02,z,no';
        await open('/notes/Menu.csv', raw);
        await column('B').click({ button: 'right' });
        const size = await page.getByRole('menu').evaluate(async (node) => {
          await Promise.all(node.getAnimations().map(animation => animation.finished));
          const {width, height} = node.getBoundingClientRect();
          return [width, height];
        });
        assert.deepEqual(size, [230, 194.5]);
        const entries = page.getByRole('menuitemradio');
        assert.deepEqual(
          await entries.evaluateAll((nodes) =>
            nodes.map((n) => n.getAttribute('aria-label')),
          ),
          [
            'Rename column',
            'Insert column left',
            'Insert column right',
            'Delete column',
            'First row is a header',
          ],
        );
        assert.equal(
          await columnItem('First row is a header').getAttribute('aria-checked'),
          'true',
        );
        assert.deepEqual(
          await page.locator('.de-column-menu kbd').allTextContents(),
          ['⌥⌘←', '⌥⌘→', '⌥⌘⌫'],
        );
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        const rename = page.getByRole('textbox', {
          name: 'Column, 中文',
          exact: true,
        });
        assert.deepEqual(
          await rename.evaluate((n) => [
            n.value,
            n.selectionStart,
            n.selectionEnd,
          ]),
          ['中文', 0, 0],
        );
        await rename.fill('Cancelled');
        await page.keyboard.press('Escape');
        assert.equal(await value(), raw);
        assert.equal(await column('B').innerText(), '中文');
        await selectColumnOption('B', 'Rename column');
        await rename.fill('Amount, USD');
        await page.keyboard.press('Enter');
        assert.equal(await value(), raw.replace('"中文"', '"Amount, USD"'));
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Row 1, Amount, USD', exact: true })
            .inputValue(),
          'a,b',
        );
        await cmd('undo');
        assert.equal(await value(), raw);
        await selectColumnOption('B', 'Insert column left');
        const inserted =
          '\ufeffID,new column,"中文",Status\r\n01,,"a,b",yes\r\n02,,z,no';
        assert.equal(await value(), inserted);
        await selectColumnOption('B', 'Delete column');
        assert.equal(await value(), raw);
        await selectColumnOption('B', 'Insert column right');
        assert.equal(
          await value(),
          '\ufeffID,"中文",new column,Status\r\n01,"a,b",,yes\r\n02,z,,no',
        );
        await cmd('undo');
        const field = page.getByRole('textbox', { name: 'Row 1, 中文' });
        await field.focus();
        await field.press('Escape');
        await page.keyboard.press('Alt+Meta+ArrowLeft');
        assert.equal(await value(), inserted);
        assert.deepEqual(
          await page.evaluate(() => [
            document.activeElement.parentElement.dataset.row,
            document.activeElement.dataset.col,
          ]),
          ['1', '1'],
        );
        await page.keyboard.press('Alt+Meta+ArrowRight');
        assert.ok(
          (await value()).startsWith('\ufeffID,new column,new column,"中文"'),
        );
        await page.keyboard.press('Alt+Meta+Backspace');
        assert.equal(await value(), inserted);
      },
    );
    await check(
      'TSV first-row header preference survives reload without rewriting disk text',
      async () => {
        const path = '/notes/Letters.tsv',
          header = Array.from({ length: 28 }, (_, i) => 'H' + i).join('\t');
        const original = header + '\r\n02\t01\r\n';
        await open(path, original);
        await selectColumnOption('A', 'First row is a header');
        assert.equal(await value(), original);
        assert.deepEqual(await page.evaluate(() => changes), []);
        for (const label of ['A', 'Z', 'AA', 'AB'])
          assert.equal(await column(label).innerText(), label);
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Row 1, B', exact: true })
            .inputValue(),
          'H1',
        );
        assert.match(
          await page.locator('.de-data-summary').innerText(),
          /2 rows · 28 columns/,
        );
        await page.reload();
        await open(path, original);
        assert.equal(await column('AB').innerText(), 'AB');
        await column('B').click();
        assert.equal(await columnItem('Rename column').count(), 0);
        assert.equal(
          await columnItem('First row is a header').getAttribute('aria-checked'),
          'false',
        );
        await columnItem('Insert column left').click();
        assert.equal(
          await value(),
          header.replace('H0\tH1', 'H0\tnew column\tH1') + '\r\n02\t\t01\r\n',
        );
        await selectColumnOption('B', 'Delete column');
        assert.equal(await value(), original);
        await page
          .getByRole('textbox', { name: 'Row 1, A', exact: true })
          .fill('Changed');
        await page.keyboard.press('Enter');
        assert.equal(await value(), original.replace('H0', 'Changed'));
        await open('/else/Letters.tsv', original);
        assert.equal(await column('A').innerText(), 'H0');
        await open(path, original);
        await selectColumnOption('A', 'First row is a header');
        assert.equal(await column('AB').innerText(), 'H27');
        await open('/notes/Ragged.csv', 'A,B,C\r\n"1"\n2,3');
        await selectColumnOption('C', 'Insert column right');
        assert.equal(await value(), 'A,B,C,new column\r\n"1",,,\n2,3,,');
        await cmd('undo');
        await selectColumnOption('C', 'Delete column');
        assert.equal(await value(), 'A,B\r\n"1"\n2,3');
        await open('/notes/Single.csv', 'Only\nOne\nTwo\n');
        await selectColumnOption('A', 'Delete column');
        assert.equal(await value(), '\n\n\n');
        await open('/notes/Empty.csv', '');
        await selectColumnOption('A', 'Insert column right');
        await selectColumnOption('A', 'Rename column');
        const blankName = page.getByRole('textbox', {name: 'Column, A'});
        assert.equal(await blankName.inputValue(), '');
        await blankName.fill('ID');
        await blankName.press('Enter');
        assert.equal(await column('A').innerText(), 'A');
        assert.equal(await value(), '');
      },
    );
    await check(
      'Full-table find returns one match per cell across pages, including real column names',
      async () => {
        const sample =
          'Needle,Count\r\n' +
          Array.from(
            { length: 301 },
            (_, i) => i + 1 + ',' + (i === 290 ? 'echo Echo echo' : 'echo'),
          ).join('\r\n');
        await open('/notes/FindGrid.csv', sample);
        const find = (query, caseSensitive = false) =>
          cmd('findDataMatches', { query, caseSensitive });
        assert.equal((await find('ECHO')).length, 301);
        assert.equal((await find('Echo', true)).length, 1);
        assert.equal((await find('title')).length, 0);
        assert.deepEqual(await find('Count'), [
          { row: 0, column: 1, from: 0, to: 5 },
        ]);
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Row 291, Count', exact: true })
            .count(),
          0,
        );
        const [match] = await find('291');
        const reveal = (arg) =>
          page.evaluate((m) => {
            const field = ed.command('revealDataMatch', m);
            return [
              field?.value ?? field?.textContent,
              field?.getAttribute('aria-label'),
            ];
          }, arg);
        assert.deepEqual(await reveal(match), ['291', 'Row 291, Needle']);
        assert.equal(
          await page
            .getByRole('textbox', { name: 'Row 291, Count', exact: true })
            .inputValue(),
          'echo Echo echo',
        );
        await selectColumnOption('A', 'First row is a header');
        assert.deepEqual(await find('B'), []);
        assert.deepEqual(await reveal((await find('Count'))[0]), [
          'Count',
          'Row 1, B',
        ]);
        await cmd('mode', 'source');
        assert.equal(await find('291'), null);
        assert.equal(await value(), sample);
      },
    );
    await check('Paged CSV reading restores page and actual edit selection, clamped to externally shortened files', async () => {
      const file = '/notes/Resume.csv';
      const rows = Array.from({length: 301}, (_, i) => (i + 1) + ',value-' + (i + 1));
      const sample = 'ID,Value\r\n' + rows.join('\r\n');
      const capture = () => page.evaluate(() => ed.captureReadingSelection());
      const restore = (reading, focus=true) => page.evaluate(([r,f]) =>
        ed.restoreReadingSelection(undefined, undefined, r, f), [reading,focus]);
      await open(file, sample);
      await page.getByRole('button',{name:'Next page'}).click();
      const pageOnly = await capture();
      assert.deepEqual(pageOnly, {grid:{page:1}});
      await open('/notes/Other.csv', 'A\nB');
      await open(file, sample);
      await restore(pageOnly);
      assert.equal(await page.locator('.de-grid-pager span').innerText(), '2 / 2');
      assert.equal(await page.locator('.de-root :focus').count(), 0);
      const cell = page.getByRole('textbox',{name:'Row 291, Value', exact:true});
      await cell.focus();
      await cell.evaluate(f=>f.setSelectionRange(2,6,'backward'));
      await cell.blur();
      const location = await capture();
      assert.deepEqual(location, {grid:{page:1,row:291,column:1,from:2,to:6,direction:'backward'}});
      await page.reload();
      await open(file, sample);
      await restore(location);
      assert.deepEqual(await cell.evaluate(f=>[document.activeElement===f,f.selectionStart,f.selectionEnd,f.selectionDirection]),[true,2,6,'backward']);
      assert.deepEqual(await page.evaluate(()=>changes),[]);
      await open(file,'ID\nZ');
      await restore(location);
      const last = page.getByRole('textbox',{name:'Row 1, ID',exact:true});
      assert.deepEqual(await last.evaluate(f=>[document.activeElement===f,f.value,f.selectionStart,f.selectionEnd]),[true,'Z',1,1]);
      await open(file,'ID\nZ');
      await restore(location,false);
      assert.equal(await page.locator('.de-root :focus').count(),0);
      assert.deepEqual(await page.evaluate(()=>changes),[]);
    });
    await check(
      'dropping Finder images uses document coordinates and one undo step',
      async () => {
        const path = '/notes/Drop.md',
          original = 'First.\n\nSecond line.';
        await open(path, original);
        const point = await page
          .locator('.ProseMirror > p')
          .last()
          .evaluate((p) => {
            const r = document.createRange();
            r.setStart(p.firstChild, 6);
            r.collapse(true);
            const box = r.getBoundingClientRect();
            return { x: box.x, y: box.y + box.height / 2 };
          });
        const batch = {
          path,
          ...point,
          images: [
            { src: 'assets/a.png', alt: 'First' },
            { src: 'assets/b c.png', alt: 'Second' },
          ],
        };
        assert.equal(
          await cmd('insertDroppedImages', {
            ...batch,
            path: '/notes/Other.md',
          }),
          false,
        );
        assert.equal(await cmd('insertDroppedImages', batch), true);
        assert.equal(
          await value(),
          'First.\n\nSecond![First](<assets/a.png>)![Second](<assets/b c.png>) line.',
        );
        assert.deepEqual(await page.evaluate(() => changes.length), 1);
        await cmd('undo');
        assert.equal(await value(), original);
        for (const mode of ['source', 'preview']) {
          await cmd('mode', mode);
          assert.equal(await cmd('insertDroppedImages', batch), false);
          assert.equal(await value(), original);
        }
        await open('/notes/a.csv', 'A,B\n1,2');
        assert.equal(
          await cmd('insertDroppedImages', { ...batch, path: '/notes/a.csv' }),
          false,
        );
      },
    );
    await check(
      'JSON field creation, rename, deletion, chips, switch and object grid',
      async () => {
        await open(
          'a.json',
          '{\n  "tags": ["first","second"],\n  "active": true,\n  "people": [{"name":"A"},{"name":"B"}]\n}',
        );
        assert.deepEqual(
          await page.evaluate(() => {
            const form = document.querySelector('.de-json-form');
            const row = form.querySelector('.de-json-row');
            return [
              form.getBoundingClientRect().width,
              row.getBoundingClientRect().height,
              getComputedStyle(form.querySelector('h1')).fontSize,
            ];
          }),
          [624, 36, '28px'],
        );
        await page.getByRole('switch', { name: 'active' }).click();
        assert.equal(JSON.parse(await value()).active, false);
        assert.equal(await page.locator('.de-chip').count(), 2);
        await page.locator('.de-chip').first().hover();
        await page.getByRole('button', { name: 'Remove tags 1' }).click();
        assert.deepEqual(JSON.parse(await value()).tags, ['second']);
        await page.getByRole('textbox', { name: 'name 2' }).fill('Z');
        assert.equal(JSON.parse(await value()).people[1].name, 'Z');
        await page
          .getByRole('button', { name: 'Add to Object', exact: true })
          .click();
        await page.getByRole('dialog').locator('input').fill('status');
        await page.getByRole('button', { name: 'Apply' }).click();
        assert.equal(JSON.parse(await value()).status, '');
        await page
          .getByRole('button', { name: 'Actions for status' })
          .click({ force: true });
        await page.getByRole('menuitem', { name: 'Rename field' }).click();
        await page.getByRole('dialog').locator('input').fill('phase');
        await page.getByRole('button', { name: 'Apply' }).click();
        assert.equal(JSON.parse(await value()).phase, '');
        await page
          .getByRole('button', { name: 'Actions for phase' })
          .click({ force: true });
        await page.getByRole('menuitem', { name: 'Delete field' }).click();
        assert.ok(!('phase' in JSON.parse(await value())));
      },
    );
    await check(
      'Add properties is available only for editable Markdown with empty metadata and preserves a draft name',
      async () => {
        const path = '/notes/Properties.markdown',
          initial = '---\r\n   \r\n---\r\nHeading';
        await open(path, initial);
        assert.equal(await cmd('canAddProperties'), true);
        assert.equal(await cmd('addProperties'), true);
        const form = page.getByRole('dialog', { name: 'Property name' });
        const input = form.getByRole('textbox');
        assert.ok(await input.evaluate((n) => n === document.activeElement));
        await input.fill('status');
        assert.equal(await cmd('addProperties'), true);
        assert.equal(await input.inputValue(), 'status');
        assert.equal(await page.getByRole('dialog').count(), 1);
        assert.equal(await value(), initial);
        await form.getByRole('button', { name: 'Apply' }).click();
        assert.equal(await cmd('canAddProperties'), false);
        assert.equal(await cmd('addProperties'), false);
        assert.match(await value(), /status: /);
        await open(path, 'Body');
        for (const mode of ['source', 'preview']) {
          await cmd('mode', mode);
          assert.equal(await cmd('canAddProperties'), false);
        }
        for (const [file, source] of [
          ['/notes/Plain.txt', 'test'],
          ['/notes/Data.csv', 'x,y'],
        ]) {
          await open(file, source);
          assert.equal(await cmd('canAddProperties'), false);
          assert.equal(await cmd('addProperties'), false);
        }
      },
    );
    await check(
      'JS and TS call colors distinguish invocation, property access and quoted text',
      async () => {
        const js = [
          'const note = "console.log(note) and other()";',
          'console.log(note);',
          'service.refresh();',
          'runTask(note);',
          'service.cache;',
          'const cached = service.refresh;',
          'new Map();',
          'Math.max(1, 2);',
          '// service.refresh() and fake(42)',
        ].join('\n');
        const ts = [
          'type Entry = { value: number };',
          'function consume(entry: Entry) { return Math.abs(entry.value); }',
          'store.save<number>(entry.value);',
          '// api.fetch()',
        ].join('\n');
        const fences = ['```js', js, '```', '', '```ts', ts, '```'].join('\n');
        await open('Calls.md', fences);
        const styleAt = await page.evaluate(() => {
          const editor = document.querySelector('.de-root');
          editor.style.colorScheme = 'dark';
          editor.style.setProperty('--fg', '#e4e4e7');
          return [...editor.querySelectorAll('.de-pre code')].map((code) => {
            const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
            const styles = [];
            while (walk.nextNode()) {
              const node = walk.currentNode,
                style = getComputedStyle(node.parentElement);
              for (const _ of node.data)
                styles.push([style.color, style.fontStyle]);
            }
            return styles;
          });
        });
        const ink = 'rgb(228, 228, 231)',
          call = 'rgb(183, 156, 245)',
          type = 'rgb(108, 196, 214)';
        const cases = [
          [0, 'console.log(note);', 'console', ink],
          [0, 'console.log(note);', 'log', call],
          [0, 'service.refresh();', 'refresh', call],
          [0, 'runTask(note);', 'runTask', call],
          [0, 'service.cache;', 'cache', ink],
          [0, 'const cached = service.refresh;', 'refresh', ink],
          [0, 'new Map();', 'Map', type],
          [0, 'Math.max(1, 2);', 'max', call],
          [
            0,
            'const note = "console.log(note) and other()";',
            'other',
            'rgb(123, 201, 149)',
          ],
          [
            0,
            '// service.refresh() and fake(42)',
            'fake',
            'rgb(138, 138, 147)',
            'italic',
          ],
          [1, 'type Entry = { value: number };', 'Entry', type],
          [1, 'return Math.abs(entry.value);', 'abs', call],
          [1, 'return Math.abs(entry.value);', 'value', ink],
          [1, 'store.save<number>(entry.value);', 'save', call],
          [1, 'store.save<number>(entry.value);', 'number', type],
          [1, '// api.fetch()', 'fetch', 'rgb(138, 138, 147)', 'italic'],
        ];
        for (const [block, excerpt, word, color, style = 'normal'] of cases) {
          const source = [js, ts][block],
            offset = source.indexOf(excerpt) + excerpt.indexOf(word);
          assert.deepEqual(
            styleAt[block][offset],
            [color, style],
            excerpt + ': ' + word,
          );
        }
        assert.equal(await value(), fences);
      },
    );
    await check(
      'format language, code wrapping and copying, note statistics',
      async () => {
        await open(
          '/notes/Sample.md',
          fs.readFileSync(
            path.resolve(__dirname, '../Samples/Workspace.md'),
            'utf8',
          ),
        );
        assert.deepEqual(await cmd('getStats'), { words: 54, chars: 347 });
        assert.equal((await cmd('getPlainText')).length, 307);
        const box = page.locator('.de-codebox').last();
        await box.hover();
        await box.getByRole('button', { name: 'Wrap' }).click();
        assert.ok(
          await box.getAttribute('class').then((c) => c.includes('de-wrapped')),
        );
        await box.getByRole('combobox').selectOption('typescript');
        assert.match(await value(), /```typescript/);
        await page.evaluate(() => {
          window.copied = '';
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async (s) => {
                window.copied = s;
              },
            },
          });
        });
        await box.getByRole('button', { name: 'Copy' }).click();
        assert.equal(
          await page.evaluate(() => copied),
          'const note = "A small experiment";',
        );
      },
    );
    await check(
      'long Markdown renders progressively and preserves untouched bytes on edit, undo and far find',
      async () => {
        const first = '\ufeff---\r\ntitle: Lab\r\n---\r\n\r\n# Start\r\n\r\nEdit here.\r\n\r\n';
        const middle = Array.from({ length: 1800 }, (_, n) =>
          '## Sample ' + n + '\r\n\r\nThe **copper** reading stayed constant.\r\n\r\n').join('');
        const source = first + middle + '## Tail\r\n\r\nLast **crossed** token.\r\n';
        // Pause only the background callback so input arrives before the tail exists in the DOM.
        await page.evaluate(() => {
          window.realIdle = window.requestIdleCallback;
          window.requestIdleCallback = () => 0;
        });
        try {
          await open('/notes/Large.md', source);
          const pm = page.locator('.ProseMirror');
          assert.equal(await cmd('isHydrating'), true);
          assert.equal(await pm.getByRole('heading', { name: 'Tail', exact: true }).count(), 0);
          await pm.locator('p').first().click();
          await page.keyboard.press('End');
          await page.keyboard.insertText(' ✓');
          const changed = source.replace('Edit here.', 'Edit here. ✓');
          assert.equal(await value(), changed);
          assert.equal(await cmd('isHydrating'), true);
          const before = await cmd('getStats');
          const hits = await cmd('findDocumentMatches', { query: 'Last crossed token' });
          assert.equal(hits.length, 1);
          assert.equal(await cmd('isHydrating'), true);
          assert.equal(await page.evaluate(h => ed.command('revealDocumentMatch',h).toString(), hits[0]),
            'Last crossed token');
          assert.equal(await cmd('isHydrating'), false);
          assert.equal(await cmd('getMode'), 'edit');
          assert.deepEqual(await cmd('getStats'), before);
          assert.equal(await value(), changed);
          await cmd('undo');
          assert.equal(await value(), source);
          await pm.locator('p').last().click();
          await page.keyboard.press('End');
          await page.keyboard.insertText(' ✓');
          assert.equal(await value(), source.replace('token.\r\n','token. ✓\r\n'));
          await cmd('source');
          assert.equal(await page.locator('.de-source').inputValue(), (await value()).replace(/\r\n/g,'\n'));
          await cmd('edit'); await cmd('focus');
          assert.equal(await cmd('isHydrating'),true);
          await page.keyboard.press('Meta+ArrowDown');
          assert.equal(await cmd('isHydrating'),false);
        } finally {
          await page.evaluate(() => { window.requestIdleCallback = realIdle; });
        }
      },
    );
    await check('reference definitions across a long note and unsplittable long paragraphs remain rich', async () => {
      const source = '[Open][note]\n\n' + 'filler\n\n'.repeat(2200) + '[note]: https://example.com\n';
      await open('/notes/References.md', source);
      assert.equal(await page.locator('.ProseMirror a').textContent(), 'Open');
      assert.equal(await value(), source);
      const paragraph = 'line\n'.repeat(20001);
      await open('/notes/Paragraph.md', paragraph);
      assert.equal(await cmd('getMode'), 'edit');
      assert.equal(await page.locator('.ProseMirror p').count(), 1);
      assert.equal(await value(), paragraph);
    });
    await check('one newline remains visible, literal arrows stay literal, tight bullet spelling survives edits', async () => {
      const source = '# Syntax\r\n\r\nSoft\r\nbreak\r\n\r\n* First\r\n* Second\r\n';
      await open('Syntax.md',source);
      const paragraph = page.locator('.ProseMirror > p');
      const y = await paragraph.evaluate(p => {
        const node = p.firstChild;
        return [0,node.length-1].map(offset => {
          const r = document.createRange(); r.setStart(node,offset);r.setEnd(node,offset+1);
          return r.getBoundingClientRect().top;
        });
      });
      assert.ok(y[1]>y[0]+12);
      const last = page.locator('.ProseMirror li p').last();
      await last.click(); await page.keyboard.press('End');
      await page.keyboard.type(' -->');
      assert.equal(await value(),source.replace('Second','Second -->'));
      await open('Arrow.md','<i>inline</i> -->\n');
      assert.equal(await page.locator('.ProseMirror').innerText(),'<i>inline</i> -->');
    });
    await check('numbered lists continue past an intervening paragraph and rejoin on Backspace', async () => {
      const original = '1. First\n2. Second\n3. Third\n';
      await open('Numbers.md',original);
      const first=page.locator('.ProseMirror li p').first();
      await first.click(); await page.keyboard.press('End');
      await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
      assert.deepEqual(await page.locator('.ProseMirror ol').evaluateAll(ns=>ns.map(n=>n.start)),[1,2]);
      await page.keyboard.type('Interlude');
      assert.match(await value(),/1\. First\n\nInterlude\n\n2\. Second\n3\. Third/);
      for (let n=0;n<'Interlude'.length+1;n++) await page.keyboard.press('Backspace');
      assert.equal(await page.locator('.ProseMirror ol').count(),1);
      assert.equal(await value(), original);
    });
    await check('formula popover above the current line, wrapped LaTeX entry and arrow-key exit', async () => {
      const source='\n\n'+ 'A row.\n\n'.repeat(75) + 'Before $x$ after.\n\n'+ 'A row.\n\n'.repeat(20);
      await open('Formula.md',source);
      const atom=page.locator('.de-inline-math');
      await atom.evaluate(n => window.scrollBy(0,n.getBoundingClientRect().bottom-innerHeight+14));
      await atom.click();
      const form=page.getByRole('dialog',{name:'Edit formula'}), field=form.locator('textarea');
      assert.equal(await form.getAttribute('data-placement'),'above');
      const a=await atom.boundingBox(), box=await form.boundingBox();
      assert.ok(Math.abs(a.y-box.height-box.y-8)<2);
      const long='a+'.repeat(90)+'b';
      await field.fill(long);
      assert.ok((await field.boundingBox()).height>40);
      await field.press('End'); await field.press('ArrowRight'); await field.waitFor({state:'hidden'});
      assert.ok((await value()).includes('$'+long+'$'));
    });

    await check(
      'external changes retain the caret across inserted blocks',
      async () => {
        await open('/notes/Caret.md', 'First paragraph.\n\nSecond target.');
        await page.locator('.ProseMirror p').last().click();
        await page.keyboard.press('End');
        await page.evaluate(() =>
          ed.setText('Inserted above.\n\nFirst paragraph.\n\nSecond target.'),
        );
        await page.keyboard.insertText(' ✓');
        assert.equal(
          await value(),
          'Inserted above.\n\nFirst paragraph.\n\nSecond target. ✓',
        );
      },
    );
    await check(
      'pending external update waits for composition and restores focus',
      async () => {
        await open('/notes/Input.md', 'Start');
        await page.locator('.ProseMirror').click();
        await page.keyboard.press('End');
        await page.evaluate(() => {
          const dom = document.querySelector('.ProseMirror');
          dom.dispatchEvent(
            new CompositionEvent('compositionstart', { bubbles: true }),
          );
          ed.setText('Start\n\nAgent note.');
        });
        assert.equal(await value(), 'Start');
        await page.evaluate(() =>
          document
            .querySelector('.ProseMirror')
            .dispatchEvent(
              new CompositionEvent('compositionend', { bubbles: true }),
            ),
        );
        await page.waitForFunction(() => ed.getText().includes('Agent note.'));
        assert.equal(await value(), 'Start\n\nAgent note.');
      },
    );

    await check(
      'conflict blocks keep unchosen bytes across edits and reopening',
      async () => {
        const nl = '\r\n';
        const marker = (mine, theirs) =>
          [
            '<<<<<<< Your version',
            mine,
            '=======',
            theirs,
            '>>>>>>> New version',
            '',
          ].join(nl);
        const a = marker('Local **first**.' + nl, 'Updated **first**.' + nl);
        const b = marker('Keep the original', 'Choose the new text');
        const original =
          '---' +
          nl +
          'one: original' +
          nl +
          '---' +
          nl +
          nl +
          'Before.' +
          nl +
          nl +
          a +
          nl +
          'Between.' +
          nl +
          nl +
          b;
        await open('/notes/Conflicts.md', original);
        const cards = page.locator('.de-conflict');
        assert.equal(await cards.count(), 2);
        assert.ok(
          (await cards.first().locator('.de-conflict-change').count()) >= 2,
        );
        await page.locator('.ProseMirror > p').first().click();
        await page.keyboard.press('End');
        await page.keyboard.insertText(' Edited.');
        const edited = original.replace('Before.', 'Before. Edited.');
        assert.equal(await value(), edited);
        await open('/notes/Conflicts.md', await value());
        assert.equal(await cards.count(), 2);
        await cards
          .last()
          .getByRole('button', { name: 'Use new version' })
          .click();
        assert.equal(await value(), edited.replace(b, 'Choose the new text'));
        assert.equal(await cards.count(), 1);
        await cmd('undo');
        assert.equal(await value(), edited);
        assert.equal(await cards.count(), 2);
        await cmd('redo');
        assert.equal(await cards.count(), 1);
        await cards.first().getByRole('button', { name: 'Keep mine' }).click();
        assert.equal(
          await value(),
          edited
            .replace(b, 'Choose the new text')
            .replace(a, 'Local **first**.' + nl),
        );
        assert.equal(
          await page.locator('.ProseMirror strong').textContent(),
          'first',
        );
        assert.equal(await cards.count(), 0);
      },
    );
    await check(
      'a deletion conflict at EOF resolves to an empty editable note',
      async () => {
        const marker =
          '<<<<<<< Your version\n\n=======\nchanged\n>>>>>>> New version\n';
        await open('/notes/Delete.md', marker);
        await page.getByRole('button', { name: 'Keep mine' }).click();
        assert.equal(await value(), '');
        await cmd('undo');
        assert.equal(await value(), marker);
        assert.equal(await page.locator('.de-conflict').count(), 1);
      },
    );
    await check(
      'native Markdown statistics agree for prose, tables, code and tasks',
      async () => {
        const notes = [
          ['# Notes\n\nAB 中文，。 CD = 12!\n', 6, 22],
          ['| A | B |\n| --- | --- |\n| C | D |\n', 4, 33],
          ['```js\nconst a = 1;\n```\n', 3, 12],
          ['- [x] Done\n- [ ] Wait\n', 3, 17],
          [
            fs.readFileSync(
              path.resolve(__dirname, 'Fixtures/Type Study/Field Notes.md'),
              'utf8',
            ),
            111,
            507,
          ],
        ];
        for (const [source, words, chars] of notes) {
          await open('/notes/Count.md', source);
          assert.deepEqual(await cmd('getStats'), { words, chars });
        }
      },
    );
    await check(
      'typography, empty properties, and editor control dimensions',
      async () => {
        const geometry = () =>
          page.evaluate(() => {
            const get = (selector) => document.querySelector(selector);
            const rect = (selector) => get(selector).getBoundingClientRect();
            const style = (selector) => getComputedStyle(get(selector));
            return {
              paragraphTracking: style('.ProseMirror').letterSpacing,
              headingTracking: style('.ProseMirror h1').letterSpacing,
              headingOffset:
                rect('.ProseMirror h1').top - rect('.de-paper').top,
              quoteInset: rect('blockquote p').left - rect('blockquote').left,
              tablePadding: style('.de-table-frame th').padding,
              codeToolbar: rect('.de-codebar').height,
              codeAction: rect('.de-code-action').width,
              checkWidth: rect('.de-task').width,
            };
          });
        const sample = fs.readFileSync(
          path.resolve(__dirname, '../Samples/Workspace.md'),
          'utf8',
        );
        await open('/notes/Workspace.md', sample);
        assert.deepEqual(await geometry(), {
          paragraphTracking: 'normal',
          headingTracking: '-0.42px',
          headingOffset: 52.5,
          quoteInset: 14,
          tablePadding: '8px 16px',
          codeToolbar: 41,
          codeAction: 28,
          checkWidth: 16,
        });
        await open(
          '/notes/Field Notes.md',
          fs.readFileSync(
            path.resolve(__dirname, 'Fixtures/Type Study/Field Notes.md'),
            'utf8',
          ),
        );
        assert.equal((await geometry()).headingOffset, 56);
        const add = page.getByRole('button', {
          name: 'Add properties',
          exact: true,
        });
        await page.locator('.ProseMirror h2').hover();
        assert.equal(
          await add.evaluate((el) => getComputedStyle(el).opacity),
          '0',
        );
        await page.locator('.ProseMirror h1').hover();
        assert.equal(
          await add.evaluate((el) => getComputedStyle(el).opacity),
          '1',
        );
      },
    );
    await check(
      'CSV geometry keeps the full final data cell editable',
      async () => {
        await open(
          '/notes/Tasks.csv',
          fs.readFileSync(
            path.resolve(__dirname, '../Samples/Tasks.csv'),
            'utf8',
          ),
        );
        const dimensions = await page.evaluate(() => {
          const bounds = (s) =>
            document.querySelector(s).getBoundingClientRect();
          const grid = bounds('.de-grid'),
            gutter = bounds('.de-rownum');
          const first = bounds('.de-grid th:nth-child(2) .de-column-trigger');
          const last = bounds(
            '.de-grid tr:nth-child(2) td:last-child textarea',
          );
          return [
            gutter.width,
            first.left - grid.left,
            last.right - grid.right,
            last.height,
          ];
        });
        assert.deepEqual(dimensions, [48, 48, 0, 36]);
      },
    );
    await check(
      'paragraph typing preserves terminal spaces, soft breaks and untouched source',
      async () => {
        const prefix = 'Keep  both\nsingle break\n\n```text\n  keep  indentation\n```\n\n';
        await open('Paragraph spaces.md', prefix + 'Seed\n');
        const paragraphs = page.locator('.ProseMirror > p');
        const newlineVisible = await paragraphs.first().evaluate((p) => {
          const text = p.firstChild, range = document.createRange();
          const topAt = (offset) => {
            range.setStart(text, offset);
            range.setEnd(text, offset + 1);
            return range.getBoundingClientRect().top;
          };
          return topAt(text.textContent.indexOf('\n') + 1) > topAt(0);
        });
        assert.equal(newlineVisible, true);
        assert.equal(await page.locator('.ProseMirror pre code').innerText(), '  keep  indentation');
        await paragraphs.last().click();
        await page.keyboard.press('End');
        for (const [key, expected] of [
          ['Space', 'Seed\u00a0'],
          ['x', 'Seed x'],
          ['Space', 'Seed x\u00a0'],
          ['Space', 'Seed x\u00a0\u00a0'],
          ['y', 'Seed x\u00a0 y'],
        ]) {
          await page.keyboard.press(key);
          assert.equal(await value(), prefix + expected + '\n');
        }
      },
    );
    assert.deepEqual(errors, []);
    console.log(passed + ' editor journeys passed');
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
