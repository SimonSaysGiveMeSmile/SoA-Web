const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { launch } = require('../server/test/fixtures/remote/harness.cjs');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path'), os = require('node:os');
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-extend-ui-'));
// Runs exclusively against fake helpers; no real Mac capture or input.

(async () => {
 const h=await launch({graceMs:30000});
 const b=await chromium.launch({headless:true});
 const errors=[];const snapshots=[];
 try {
  const c=await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));
  await p.goto(h.base);await p.waitForFunction(()=>window.__soaRemote?.decoded>0,{timeout:15000});
  await p.click('#b-res');await p.waitForFunction(()=>!document.getElementById('e-extend').disabled);
  await p.screenshot({path:path.join(artifacts, 'mirror.png')});
  await p.click('#e-extend');
  await p.waitForFunction(()=>document.getElementById('e-extend').getAttribute('aria-pressed')==='true'&&/Move a window/.test(document.getElementById('e-msg').textContent));
  await p.screenshot({path:path.join(artifacts, 'controls.png')});
  snapshots.push({view:'phone',message:await p.locator('#e-msg').textContent(),hiddenMain:await p.locator('#mirror-controls').isHidden()});
  await p.click('#sheet-x');await p.waitForFunction(()=>document.getElementById('overlay').hidden,{timeout:15000});
  await p.screenshot({path:path.join(artifacts, 'desktop.png')});
  await p.click('#b-res');await p.click('[data-e-position="left"]');await p.waitForFunction(()=>/left edge/.test(document.getElementById('e-msg').textContent));
  await p.reload();await p.waitForFunction(()=>document.getElementById('overlay').hidden,{timeout:15000});
  await p.click('#b-res');assert.match(await p.locator('#e-msg').textContent(),/left edge/);
  const creates=h.calls().filter(x=>x.kind==='virtual'&&String(x.message).startsWith('create')).length;assert.equal(creates,1);
  for(const [width,height]of[[844,390],[768,1024],[1024,768],[320,740]]) {
   await p.setViewportSize({width,height});await p.waitForTimeout(3200);
   await p.locator('#h-desktop').scrollIntoViewIfNeeded();
   const geom=await p.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('#e-mode button,#e-controls button')].filter(x=>x.offsetParent).map(x=>{const r=x.getBoundingClientRect();return{label:x.textContent,x:r.x,right:r.right,w:r.width,h:r.height}})}));
   assert.ok(geom.scrollWidth<=width);assert.ok(geom.buttons.every(x=>x.x>=0&&x.right<=width&&x.h>=44));snapshots.push({view:width+'x'+height,...geom});
  }
  await p.emulateMedia({colorScheme:'dark'});
  await p.screenshot({path:path.join(artifacts, 'dark.png')});
  await p.click('#e-mirror');await p.waitForFunction(()=>document.getElementById('e-mirror').getAttribute('aria-pressed')==='true');
  assert.equal(await p.locator('#mirror-controls').isVisible(),true);
  await p.click('#sheet-x');await p.waitForFunction(()=>document.getElementById('overlay').hidden,{timeout:15000});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,artifacts,snapshots,errors,creates},null,2));
 } catch(e) {console.log('BROWSER FAILURE',e.stack);console.log(h.logs());throw e;}
 finally {await b.close();await h.stop();}
})();
