// Two real writers race against the isolated bridge. Check both the page and disk.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE);
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');

async function main() {
  let payload = '';
  for await (const chunk of process.stdin) payload += chunk;
  const {url,file} = JSON.parse(payload);
  const browser = await chromium.launch({channel:'chrome'});
  const base = '# Trial\n\nFirst before.\n\nMiddle local.\n\nLast before.\n';
  const page = await browser.newPage();
  page.setDefaultTimeout(6500);
  const failures = [];
  page.on('pageerror', error => failures.push(String(error)));
  const editor = page.locator('.ProseMirror');
  const button = (name) => page.getByRole('button',{name,exact:true});
  const disk = async text => {
    for (let i=0;i<75;i++) {
      if ((await fs.readFile(file,'utf8')) === text) return;
      await page.waitForTimeout(60);
    }
    assert.equal(await fs.readFile(file,'utf8'), text);
  };
  const edit = async (line,addition,replace=false) => {
    await editor.getByText(line,{exact:true}).click();
    await page.keyboard.press('End');
    if (replace) await editor.getByText(line,{exact:true}).evaluate(node=>{
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    });
    await page.keyboard.insertText(addition);
  };
  const fresh = async () => {
    await fs.writeFile(file,base);
    await page.goto(url);
    await editor.getByText('First before.',{exact:true}).waitFor();
  };
  try {
    await fresh();
    await edit('Middle local.',' My edit.');
    const remote = base.replaceAll('before','changed');
    await fs.writeFile(file,remote);
    await button('Show changes').click();
    const card = page.getByRole('dialog',{name:'What the new version changed'});
    await card.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.reader-change').length === 2).catch(async err=>{
      throw Error(err.message + ' ' + JSON.stringify([failures,await editor.innerHTML(),await page.locator('#merge-message').textContent()]));
    });
    assert.equal(await button('Previous').isDisabled(),true);
    await button('Next').click();
    assert.equal(await button('Next').isDisabled(),true);
    await button('Previous').click();
    await page.keyboard.press('Escape');
    await card.waitFor({state:'hidden'});
    await edit('Middle local. My edit.',' Later.');
    await editor.getByText('First changed.',{exact:true}).click();
    await card.getByRole('button',{name:/^Before/}).hover();
    await editor.locator('.reader-change-preview').getByText('First before.',{exact:true}).waitFor();
    await disk(remote.replace('Middle local.','Middle local. My edit. Later.'));
    await card.getByRole('button',{name:/^Before/}).click();
    assert.equal(await page.locator('#merge-message').textContent(),'The new version changed one paragraph.');
    await card.getByRole('button',{name:/^Now/}).click();
    await disk(remote.replace('First changed.','First before.').replace('Middle local.','Middle local. My edit. Later.'));

    await fresh();
    await edit('Middle local.',' My edit.');
    await fs.writeFile(file,remote);
    await button('Undo').waitFor();
    await edit('Middle local. My edit.',' Afterwards.');
    await button('Undo').click();
    await disk(base.replace('Middle local.','Middle local. My edit. Afterwards.'));

    await fresh();
    await edit('Middle local.','Mine replacement.',true);
    const theirs = base.replace('Middle local.','Theirs replacement.');
    await fs.writeFile(file,theirs);
    const conflict = page.getByRole('dialog',{name:'Choose which version to keep'});
    await conflict.waitFor();
    assert.equal(await editor.getByText('Mine replacement.',{exact:true}).count(),1);
    assert.equal(await editor.getByText(/<<<<<<<|=======|>>>>>>>/).count(),0);
    await edit('First before.',' Kept.');
    const partial=theirs.replace('First before.','First before. Kept.');
    await disk(partial);
    const externalReader=await browser.newPage();
    await externalReader.goto(url);
    await externalReader.locator('.ProseMirror').getByText('Theirs replacement.',{exact:true}).waitFor();
    assert.equal(await externalReader.locator('#merge-banner').isHidden(),true);
    await externalReader.close();
    await page.reload();
    await button('Keep all mine').waitFor();
    await conflict.waitFor({state:'hidden'});
    const markedParagraph='<!-- samare:undecided yours: two versions of this part, not chosen yet. Yours first, then the new one. -->\n\nMine replacement.\n\n<!-- samare:undecided new -->\n\nTheirs replacement.\n\n<!-- samare:undecided end -->';
    await disk(partial.replace('Theirs replacement.',markedParagraph));
    const reopened=await browser.newPage();
    await reopened.goto(url);
    await reopened.getByRole('button',{name:'Keep all mine',exact:true}).waitFor();
    await reopened.locator('.ProseMirror').getByText('Mine replacement.',{exact:true}).waitFor();
    await reopened.close();
    await editor.getByText('Mine replacement.',{exact:true}).click();
    await button('Keep both').click();
    await disk(theirs.replace('First before.','First before. Kept.').replace('Theirs replacement.','Mine replacement.\n\nTheirs replacement.'));

    await fresh();
    await edit('Middle local.','Mine again.',true);
    await fs.writeFile(file,theirs);
    await conflict.waitFor();
    await edit('First before.',' Retained.');
    await button('Use all new').click();
    await disk(theirs.replace('First before.','First before. Retained.'));
    await fresh();
    await edit('Middle local.',' My edit.');
    await fs.writeFile(file,remote);
    await button('Show changes').click();
    await card.waitFor();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await disk(remote.replace('First changed.','First before.').replace('Middle local.','Middle local. My edit.'));

    await fresh();
    await edit('Middle local.',' My edit.');
    await fs.writeFile(file,remote);
    await button('Undo').waitFor();
    await edit('First changed.','First newer draft.',true);
    await button('Undo').click();
    await page.getByText(/Some paragraphs have newer edits/).waitFor();
    await disk(remote.replace('First changed.','First newer draft.').replace('Middle local.','Middle local. My edit.'));
    await button('Show changes').click();
    await card.getByRole('button',{name:/^Before/}).click();
    await page.getByText(/This paragraph has newer edits/).waitFor();
    await card.getByRole('button',{name:/^Now/}).click();
    await card.getByRole('button',{name:/^Before/}).click();
    await disk(base.replace('First before.','First newer draft.').replace('Middle local.','Middle local. My edit.'));
    const big = base + '\n' + 'Extra reading material. '.repeat(3700) + '\n';
    await fs.writeFile(file,big);
    await page.goto(url);
    await editor.getByText('Middle local.',{exact:true}).waitFor();
    const prepared = page.waitForResponse(reply => reply.url().includes('/api/') &&
      reply.request().method() === 'POST' && (reply.request().postDataJSON()?.preparedReview?.length || 0) > 65536 && reply.status() === 200);
    const bigMine='My word. '.repeat(8200).trimEnd();
    await edit('Middle local.',bigMine,true);
    await fs.writeFile(file,big.replace('Middle local.','Large remote.'));
    await conflict.waitFor();
    await prepared;
    await page.goto('about:blank');
    const independent = await browser.newPage();
    await independent.goto(url);
    await independent.getByRole('button',{name:'Keep all mine',exact:true}).click();
    await disk(big.replace('Middle local.',bigMine));
    await independent.close();
    const fenced='# Literal example\n\n' + '````markdown\n' + markedParagraph + '\n````\n';
    await fs.writeFile(file,fenced);
    await page.goto(url);
    await editor.waitFor();
    assert.equal(await page.locator('#merge-banner').isHidden(),true);
    await disk(fenced);
    assert.deepEqual(failures,[]);
    console.log('Browser merge review, per-paragraph decisions, later edits, global undo and conflict refresh passed.');
  } finally { await browser.close(); }
}
main().catch(error=>{console.error(String(error.stack || error).replace(/https?:\/\/[^\s"']+/g,'[fixture URL]'));process.exitCode=1;});
