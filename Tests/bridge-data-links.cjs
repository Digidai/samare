// Opens each registered document through the ordinary URL returned by its Agent CLI.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  let input='';for await(const chunk of process.stdin)input+=chunk;
  const cases=JSON.parse(input);
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    for(const {kind,path,url,initial} of cases){
      const page=await browser.newPage();
      await page.goto(url);
      const sourceButton=page.getByRole('button',{name:'Source',exact:true}).first();
      await sourceButton.click({timeout:7000});
      const source = page.locator('textarea.de-source:visible').first();
      assert.equal(await source.inputValue(), initial);
      const changed = initial.replaceAll('Alpha', 'Beta');
      await source.fill(changed);
      const deadline = Date.now() + 12000;
      while (await fs.readFile(path, 'utf8') !== changed) {
        if (Date.now() > deadline) throw Error(kind + ' write did not reach disk');
        await page.waitForTimeout(100);
      }
      await page.reload();
      await page.getByRole('button', {name:'Source',exact:true}).first().click();
      assert.equal(await source.inputValue(), changed);
      console.log(kind, 'registered link, browser edit, on-disk bytes and reopen verified');
      await page.close();
    }
  }finally{await browser.close();}
})().catch(e=>{console.error(String(e).replace(/https?:\/\/[^\s]+/g,'[URL]'));process.exitCode=1});
