const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || undefined});
  try {
    const page=await browser.newPage({viewport:{width:1250,height:850}});
    const msgs=[];
    page.on('pageerror', error=>msgs.push(error.message));
    await page.addInitScript(()=>{window.sent=[];window.webkit={messageHandlers:{host:{postMessage(m){sent.push(m)}}}}});
    await page.goto(pathToFileURL(path.resolve(__dirname,'../Resources/index.html')).href);
    const note='/test/Changes.md';
    const text=[
      '# Changes', '', String.raw`A \[\[Weekly digest\]\] and [[Plan#Next steps]].`, '',
      '| 表格 | Name |','|---|---|','| 東京 | A |','| 字 | |','',
      '```go','package main','func main() {}','```','','```zsh','if true; then echo "yes"; fi','```',
      '','[Example](https://example.com/test)','','- sample list'
    ].join('\n');
    await page.evaluate(({note,text})=>hostEvent('bootstrap',{files:[{path:note,text,name:'Changes.md'}],activePath:note,settings:{theme:'light'}}),{note,text});
    const p=page.locator('.ProseMirror');
    assert.equal(await p.locator('a').filter({hasText:'Weekly digest'}).count(),1);
    const caretEnd = async locator => {
      await locator.evaluate(n => {
        n.closest('.ProseMirror').focus();
        const r = document.createRange(); r.selectNodeContents(n); r.collapse(false);
        getSelection().removeAllRanges(); getSelection().addRange(r);
        document.dispatchEvent(new Event('selectionchange'));
      });
    };
    await caretEnd(p.locator('p').filter({hasText:'Weekly digest'}));
    await page.keyboard.insertText('✓');
    await page.waitForFunction(()=>sent.some(m=>m.type==='save'));
    const latest=()=>page.evaluate(()=>sent.filter(m=>m.type==='save').at(-1)?.text);
    assert.match(await latest(),/A \[\[Weekly digest\]\] and \[\[Plan#Next steps\]\]\.✓/);
    await page.evaluate(()=>{const m=sent.filter(m=>m.type==='save').at(-1);hostEvent('saved',m)});
    await caretEnd(p.locator('td').first().locator('p'));
    await page.keyboard.insertText('市');
    await page.waitForFunction(()=>sent.filter(m=>m.type==='save').some(m=>m.text.includes('東京市')));
    const table=(await latest()).split('\n').filter(l=>l.startsWith('|'));
    const offsets=table.map(line=>Array.from(line.slice(1,line.indexOf('|',1))).reduce((n,c)=>n+(/[\u4e00-\u9fff]/.test(c)?2:1),0));
    assert.ok(offsets.length===4 && offsets.every(o=>o===offsets[0]),table.join('\n'));
    assert.ok(!table.join('\n').includes('<br'));
    for(const box of await p.locator('.de-codebox').all()) assert.ok(await box.locator('code span').count()>0);
    const lang=p.locator('.de-language-select').first();
    await lang.click();
    const menu=page.getByRole('listbox',{name:'Choose code language'});
    await menu.getByRole('option',{name:'TypeScript',exact:true}).click();
    assert.equal(await lang.inputValue(),'typescript');
    await page.evaluate(()=>hostEvent('command','exportPDF'));
    await page.waitForFunction(()=>sent.some(m=>m.type==='exportPDF'));
    const exported=await page.evaluate(()=>sent.find(m=>m.type==='exportPDF').html);
    assert.match(exported,/<thead>/);assert.match(exported,/href="https:\/\/example.com\/test"/);
    const sizes=async()=>page.evaluate(()=>['.ProseMirror p','.ProseMirror li','#side-toggle','.tab'].map(q=>document.querySelector(q).getBoundingClientRect().height));
    const original=await sizes();
    for(let i=0;i<12;i++) await page.evaluate(()=>hostEvent('command','zoomIn'));
    const large=await sizes();
    assert.ok(large[0]>=original[0]*1.95 && large[1]>=original[1]*1.95);
    assert.deepEqual(large.slice(2),original.slice(2));
    for(let i=0;i<15;i++) await page.evaluate(()=>hostEvent('command','zoomOut'));
    const small=await sizes();
    assert.ok(small[0]<original[0]*.82 && small[0]>original[0]*.77);
    await page.evaluate(()=>hostEvent('command','zoomReset'));
    assert.deepEqual(await sizes(),original);
    const mount = async (name,text) => page.evaluate(([name,text]) => {
      window.hist?.destroy();
      const mount = document.querySelector('#hist') || document.body.appendChild(document.createElement('div'));
      mount.id = 'hist'; Object.assign(mount.style,{position:'fixed',inset:'60px',overflow:'auto',background:'white',zIndex:200});
      window.hist = SamareEditor.mount(mount,{path:name,text,settings:{}});
    },[name,text]);
    await mount('Tasks.md','- [ ] 1. Open the big file\n\n1. [ ] Open another file\n');
    await page.locator('#hist .de-task').first().check();
    assert.match(await page.evaluate(()=>hist.getText()),/- \[x\] 1\. Open the big file/);
    await page.locator('#hist .de-task').last().check();
    assert.match(await page.evaluate(()=>hist.getText()),/1\. \[x\] Open another file/);
    await mount('Divider.md','Head\n\n---\n\nTail\n');
    const tail=page.locator('#hist .ProseMirror p').last();
    await tail.evaluate(n => {
      n.closest('.ProseMirror').focus();
      const r=document.createRange();r.selectNodeContents(n);r.collapse(true);
      getSelection().removeAllRanges();getSelection().addRange(r);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await page.keyboard.press('Enter');
    const blank=page.locator('#hist .ProseMirror p').nth(1);
    assert.equal(await blank.textContent(),'');
    await blank.click();
    await page.keyboard.press('Backspace');
    assert.equal(await page.locator('#hist hr').count(),1);
    assert.equal(await page.locator('#hist .ProseMirror p').count(),2,await page.locator('#hist .ProseMirror').innerHTML());
    await mount('Example.jsonl','{"x":1}\n{"x":2}\n');
    const title=page.locator('#hist .de-data-header h1');
    const where=()=>title.evaluate(n=>[n.getBoundingClientRect().left,n.getBoundingClientRect().top]);
    const recordTitle=await where();
    await page.locator('#hist').getByRole('button',{name:'Source'}).click();
    assert.deepEqual(await where(),recordTitle);
    await page.locator('#hist').getByRole('button',{name:'Records'}).click();
    assert.deepEqual(await where(),recordTitle);
    const sourceTimings = [];
    for (const [name,text] of [
      ['large.json', JSON.stringify({payload:'ab'.repeat(1100000)})],
      ['large.csv','id,value\n'+Array.from({length:13000},(_,i)=>i+','+'ab'.repeat(90)).join('\n')],
      ['large.jsonl',Array.from({length:12000},(_,i)=>JSON.stringify({i,v:'ab'.repeat(90)})).join('\n')]
    ]) {
      const kind=name.endsWith('.jsonl')?'Records':name.endsWith('.csv')?'Table':'Fields';
      const target=page.locator('#hist');
      const structure=kind==='Records'?'.de-log-record':kind==='Table'?'.de-grid tbody tr':'.de-json-row';
      const start=performance.now();
      await mount(name,text);
      await target.locator(structure).first().waitFor();
      assert.equal(await target.getByRole('button',{name:kind,exact:true}).getAttribute('aria-pressed'),'true');
      assert.ok(await target.locator(structure).count()<=500);
      const structuredMs=Math.round(performance.now()-start);
      const sourceStart=performance.now();
      await target.getByRole('button',{name:'Source',exact:true}).click();
      const area=target.locator('textarea.de-source');
      await area.waitFor({state:'visible'});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const sourceMs=Math.round(performance.now()-sourceStart);
      assert.equal(await area.inputValue(),text);
      await target.getByRole('button',{name:kind,exact:true}).click();
      await target.locator(structure).first().waitFor();
      assert.equal(await page.evaluate(()=>hist.getText()),text);
      if(kind==='Records'){
        await target.getByRole('button',{name:'Next page'}).click();
        assert.equal(await target.locator('.de-log-number').first().innerText(),'101');
        await target.getByRole('button',{name:'Newest first'}).click();
        assert.equal(await target.locator('.de-log-number').first().innerText(),'12000');
        await target.getByLabel('Line 12000',{exact:true}).click();
        const lastNumber=target.getByRole('textbox',{name:'i',exact:true});
        await lastNumber.fill('20777');
        const saved=await page.evaluate(()=>hist.getText());
        assert.equal(saved,text.replace('"i":11999','"i":20777'));
        await target.getByRole('button',{name:'Source',exact:true}).click();
        assert.equal(await area.inputValue(),saved);
      }
      if(kind==='Fields'){
        await target.getByRole('button',{name:'payload',exact:true}).click();
        assert.equal((await target.getByRole('textbox',{name:'payload',exact:true}).inputValue()).length,2200000);
      }
      sourceTimings.push({name,bytes:Buffer.byteLength(text),structuredMs,clickToSourceFrameMs:sourceMs});
    }
    // A spread into Math.max throws on this row count in Chrome. None of these short rows needs a large DOM.
    const tall='id,value\n'+'a,b\n'.repeat(150000);
    await mount('Tall.csv',tall);
    await page.locator('#hist .de-grid tbody tr').first().waitFor();
    assert.equal(await page.locator('#hist .de-data-summary').innerText(),'150,000 rows · 2 columns');
    await page.locator('#hist').getByRole('button',{name:'Source',exact:true}).click();
    assert.equal(await page.locator('#hist textarea.de-source').inputValue(),tall);
    // Start directly in raw view while initial layout is pending. Parsing this
    // fixture would visit the unique key. Switching away before the next frame
    // must leave the source readable without any structural parse.
    const direct=await page.evaluate(async()=>{
      hist.destroy(); const original=JSON.parse; let parsed=0;
      const source='{"rawOnlyProbe":"'+'a'.repeat(1600000)+'"}';
      JSON.parse=function(value,...args){if(value==='"rawOnlyProbe"')parsed++;return original.call(JSON,value,...args)};
      try {
        window.hist=SamareEditor.mount(document.querySelector('#hist'),{path:'direct.json',text:source});
        hist.command('mode','source');
        await new Promise(resolve=>requestAnimationFrame(()=>setTimeout(resolve,30)));
        return [document.querySelector('#hist .de-source').value===source,parsed];
      } finally {JSON.parse=original;}
    });
    assert.deepEqual(direct,[true,0]);
    const veryWide={items:Array.from({length:90},(_,index)=>Object.fromEntries(Array.from({length:50},(_,col)=>['field'+index+'_'+col,col])))};
    await mount('Wide.json',JSON.stringify(veryWide));
    assert.equal(await page.locator('#hist .de-object-grid').count(),0);
    assert.ok(await page.locator('#hist *').count()<2200);
    console.log('Source measurements '+JSON.stringify(sourceTimings));
    assert.deepEqual(msgs,[]);
    console.log('Passed legacy wiki migration, CJK plain-source column alignment, blank cells, Go / zsh syntax, accessible language menu, export table and URL structure, 80–200% body/list zoom with fixed chrome, divider/numbered task regression, stable JSONL title and source round-trip for CSV/JSON/JSONL over 2 MB.');
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
