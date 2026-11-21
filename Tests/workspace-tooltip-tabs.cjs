// Real Chrome mouse and keyboard events on the production workspace shell.
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1040,height:760}});
    const name = 'Workspace containing Chinese and English with a very long title 真实的项目文件夹名称';
    await page.addInitScript(name => {
      const dir = '/fixture/' + name;
      const files = ['First.md','Second.md','Last.md'].map((n) => ({path:dir+'/'+n,name:n,text:'# '+n}));
      window.webkit={messageHandlers:{host:{postMessage(m){
        const send=(key,payload)=>queueMicrotask(()=>window.hostEvent(key,payload));
        if(m.type==='ready')send('bootstrap',{workspaces:[{path:dir,name}],activeWorkspace:dir,files,activePath:files[2].path,settings:{}});
        if(m.type==='listFolder')send('listing',{path:dir,entries:files});
      }}}};
    },name);
    await page.goto(pathToFileURL(path.resolve(__dirname,'../Resources/index.html')).href);
    const active=page.locator('[role=tab][aria-selected=true]');
    await active.waitFor();assert.equal(path.basename(await active.getAttribute('title')),'Last.md');
    // Use physical bracket codes with the Shift modifier, as on a Mac keyboard.
    await page.keyboard.press('Meta+Shift+BracketRight');
    assert.equal(path.basename(await active.getAttribute('title')),'First.md');
    await page.keyboard.press('Meta+Shift+BracketLeft');
    assert.equal(path.basename(await active.getAttribute('title')),'Last.md');
    const hoverTitle=async locator=>{
      await locator.hover();
      const result=await locator.evaluate(el=>({clipped:el.scrollWidth>el.clientWidth,overflow:getComputedStyle(el).textOverflow,title:el.closest('[title]')?.title,underPointer:el.matches(':hover')}));
      assert.equal(result.clipped,true);assert.equal(result.overflow,'ellipsis');assert.equal(result.underPointer,true);
      assert.equal(result.title,name);
    };
    await hoverTitle(page.locator('.workspace-head .grow'));
    await page.getByRole('button',{name:'Back to workspaces',exact:true}).click();
    await hoverTitle(page.getByRole('button',{name,exact:true}).locator('> .grow'));
    console.log('Chrome verified first/last tab keyboard wrap and a native title hit area for the full clipped workspace name in both sidebar views.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
