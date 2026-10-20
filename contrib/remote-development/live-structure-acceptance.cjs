#!/usr/bin/env node
/* Authenticated Cabinet / Structure acceptance for approved Development only.
 * Default: read-only live absence audit. --exercise is an explicit write opt-in,
 * creates an isolated cabinet, and refuses to write unless the live UI exposes
 * the feature. --restart additionally opts into the restricted Dev restart. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const args = new Set(process.argv.slice(2));
for (const arg of args) assert.ok(['--exercise', '--restart'].includes(arg), `unknown option: ${arg}`);
const exercise = args.has('--exercise'), restart = args.has('--restart');
assert.ok(!restart || exercise, '--restart requires --exercise');
const base = process.env.SL_BASE_URL || 'http://192.168.1.108:18081';
assert.equal(base, 'http://192.168.1.108:18081', 'restricted to approved Development');
const api = '/plugin/storage-layout/api/v1/';
const evidenceDir = path.resolve(__dirname, '../../docs/storage-layout/images');
const remote = command => execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','spetchal@mainserver-1',command], {encoding:'utf8', timeout:30000}).trim();
const screenshot = async (page, name) => { fs.mkdirSync(evidenceDir, {recursive:true}); const file=path.join(evidenceDir,name); await page.screenshot({path:file,fullPage:true}); console.log(`SCREENSHOT ${path.relative(process.cwd(),file)}`); };
(async () => {
  const password = remote("sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\"");
  assert.ok(password);
  const browser = await chromium.launch({headless:true,...(process.env.SL_CHROMIUM_PATH ? {executablePath:process.env.SL_CHROMIUM_PATH}: {})});
  try {
    const context=await browser.newContext({viewport:{width:1600,height:1100}}), page=await context.newPage();
    page.on('pageerror',error=>console.log(`BROWSER PAGEERROR ${error.name}: ${error.message}`));
    page.on('console',message=>{if(message.type()==='error')console.log(`BROWSER CONSOLE ${message.text().slice(0,300)}`);});
    await page.goto(`${base}/web/login`,{waitUntil:'domcontentloaded'});
    await page.getByLabel('login-username').waitFor({timeout:20000});
    await page.getByLabel('login-username').fill('sl_admin'); await page.getByLabel('login-password').fill(password);
    await page.getByRole('button',{name:'Log In',exact:true}).click();
    await page.getByLabel('navigation-menu').waitFor({timeout:30000});
    const csrf=(await context.cookies()).find(c=>c.name==='csrftoken')?.value; assert.ok(csrf);
    const headers={'X-CSRFToken':csrf,Referer:`${base}/web/`};
    const req=(method,url,data,extra={})=>context.request[method](base+url,{headers:{...headers,...extra},...(data===undefined?{}:{data})});
    const existingId='4664428c-f9f4-4722-a468-43a2c95c9a1f';
    await page.goto(`${base}/web/plugin/storage-layout/cabinets/${existingId}/design`,{waitUntil:'domcontentloaded'});
    await page.getByTestId('cabinet-designer').waitFor({timeout:30000});
    const tab=page.getByRole('tab',{name:'Cabinet / Structure',exact:true});
    if (!exercise) {
      const before=path.join(evidenceDir,'live-structure-development-before-refresh.png');
      await screenshot(page,path.basename(before));
      if (!(await tab.isVisible().catch(()=>false))) {
        await page.reload({waitUntil:'domcontentloaded'}); await page.getByTestId('cabinet-designer').waitFor({timeout:30000});
        assert.equal(await page.getByRole('tab',{name:'Cabinet / Structure',exact:true}).isVisible().catch(()=>false),false,'structure mode remains absent after refresh');
        await screenshot(page,'live-structure-development-after-refresh.png');
        console.log('LIVE RESULT: authenticated Development does not expose Cabinet / Structure before or after refresh. No records changed.');
      } else console.log('LIVE RESULT: Cabinet / Structure tab is present. Default audit made no edits or API writes.');
      return;
    }
    // Refuse before fixture creation unless the deployed app genuinely exposes the new editor.
    assert.ok(await tab.isVisible().catch(()=>false), 'refusing --exercise: Cabinet / Structure is absent from current live Development');
    const uuid=crypto.randomUUID(), name=`SL structure acceptance ${uuid}`;
    const create=await req('post',api+'cabinets/',{name,slug:`sl-structure-${uuid}`,root_location_name:name,width_units:500,height_units:500});
    assert.equal(create.status(),201,`fixture create HTTP ${create.status()}`);
    const cabinet=await create.json(), cabinetUrl=`${api}cabinets/${cabinet.id}/`, layoutUrl=`${api}cabinets/${cabinet.id}/layout/`;
    const readCabinet=async()=>{const response=await req('get',cabinetUrl);assert.equal(response.status(),200,`cabinet GET HTTP ${response.status()}`);return response.json();};
    const baseline=await readCabinet();
    const layoutResponse=await req('get',layoutUrl); assert.equal(layoutResponse.status(),200,`layout GET HTTP ${layoutResponse.status()}`);
    const baselineLayout=await layoutResponse.json();
    const assertLayoutPreserved=async expectedRevision=>{
      const response=await req('get',layoutUrl); assert.equal(response.status(),200,`layout GET HTTP ${response.status()}`);
      const actual=await response.json();
      assert.equal(actual.cabinet.revision,expectedRevision,'logical layout revision must match the cabinet revision');
      assert.deepEqual({...actual,cabinet:{...actual.cabinet,revision:baselineLayout.cabinet.revision}},baselineLayout,'structure editing changed logical layout data');
    };
    const designUrl=`${base}/web/plugin/storage-layout/cabinets/${cabinet.id}/design`;
    await page.goto(designUrl,{waitUntil:'domcontentloaded'}); await page.getByTestId('cabinet-designer').waitFor({timeout:30000});
    await page.getByRole('tab',{name:'Cabinet / Structure',exact:true}).click();
    for (const [label,value] of [['Width (mm)','600'],['Height (mm)','800'],['Depth (mm)','400']]) await page.getByLabel(label,{exact:true}).fill(value);
    await page.getByRole('button',{name:'Initialize structure',exact:true}).click();
    const svg=page.getByRole('img',{name:'Cabinet structure drawing'}); await svg.waitFor({state:'visible'});
    const dragCanvas=async(x1,y1,x2,y2)=>{
      const points=await svg.evaluate((node, p)=>{const r=node.getBoundingClientRect(); const g=node.querySelector('g[transform]'),m=g?.getScreenCTM(); if(!m)throw Error('structure SVG transform unavailable'); const a=new DOMPoint(p[0],p[1]).matrixTransform(m),b=new DOMPoint(p[2],p[3]).matrixTransform(m); return [{x:a.x,y:a.y},{x:b.x,y:b.y}];},[x1,y1,x2,y2]);
      await page.mouse.move(points[0].x,points[0].y); await page.mouse.down(); await page.mouse.move(points[1].x,points[1].y,{steps:10}); await page.mouse.up();
    };
    await page.getByRole('button',{name:'Draw Cabinet',exact:true}).click(); await dragCanvas(10,10,590,790);
    const featureDrags = {partition:[40,40,60,760],shelf:[80,100,560,120],opening:[80,200,300,300]};
    for (const [feature, coordinates] of Object.entries(featureDrags)) { await page.getByRole('button',{name:new RegExp(`^${feature}$`,'i')}).click(); await dragCanvas(...coordinates); }
    for (const [feature, coordinates] of Object.entries({door:[330,400,430,700],panel:[450,400,550,700]})) { await page.getByRole('button',{name:new RegExp(`^${feature}$`,'i')}).click(); await dragCanvas(...coordinates); }
    const featureCounts = Object.fromEntries(['partition','shelf','opening','door','panel'].map(type => [type, page.getByTestId(`feature-${type}`).count()]));
    const observedFeatureCounts = Object.fromEntries(await Promise.all(Object.entries(featureCounts).map(async ([type, count]) => [type, await count])));
    if (Object.values(observedFeatureCounts).some(count => count !== 1)) {
      console.log(`DRAW DIAGNOSTIC cabinet=${cabinet.id} counts=${JSON.stringify(observedFeatureCounts)}`);
      console.log(`DRAW DIAGNOSTIC active buttons=${JSON.stringify(await page.getByRole('button').allTextContents())}`);
      await screenshot(page,'live-structure-exercise-draw-failure.png');
      console.log(`DRAW DIAGNOSTIC svg=${(await svg.evaluate(node => node.outerHTML)).slice(0,12000)}`);
    }
    assert.deepEqual(observedFeatureCounts, {partition:1,shelf:1,opening:1,door:1,panel:1});
    await screenshot(page,'live-structure-exercise-drawn.png');
    // Resize the envelope and selected feature using the real pointer handles.
    console.log(`UI DIAGNOSTIC url=${page.url()} designer=${await page.getByTestId('cabinet-designer').count()} svg=${await svg.count()} envelope=${await page.getByTestId('cabinet-envelope').count()} handles=${await page.getByTestId('cabinet-resize-handle').count()}`);
    const envelopeHandle=page.getByTestId('cabinet-resize-handle'); let box=await envelopeHandle.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down(); await page.mouse.move(box.x+box.width/2+12,box.y+box.height/2+12,{steps:6}); await page.mouse.up();
    const featureBox = async type => page.getByTestId(`feature-${type}`).boundingBox();
    const moveFeature = async (type,dx,dy) => { const b=await featureBox(type); assert.ok(b); await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down(); await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:6}); await page.mouse.up(); };
    const resizeFeature = async (type,dx,dy) => { await page.getByTestId(`feature-${type}`).click(); const h=page.getByTestId('feature-resize-handle'); const b=await h.boundingBox(); assert.ok(b); await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down(); await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:6}); await page.mouse.up(); };
    await page.getByRole('button',{name:'Snap on',exact:true}).click();
    await page.getByRole('button',{name:'Snap off',exact:true}).waitFor();
    await page.getByRole('button',{name:'Zoom in',exact:true}).click();
    assert.match(await svg.locator('g[transform]').getAttribute('transform'),/scale\(1\.1\)/);
    await page.getByRole('button',{name:'Fit',exact:true}).click();
    assert.match(await svg.locator('g[transform]').getAttribute('transform'),/translate\(30,20\) scale\(1\)/);
    await page.getByRole('combobox',{name:'Tool'}).click(); await page.getByRole('option',{name:'pan',exact:true}).click();
    const svgBox=await svg.boundingBox(); assert.ok(svgBox); await page.mouse.move(svgBox.x+100,svgBox.y+100); await page.mouse.down(); await page.mouse.move(svgBox.x+120,svgBox.y+115,{steps:4}); await page.mouse.up();
    assert.match(await svg.locator('g[transform]').getAttribute('transform'),/translate\(50,35\) scale\(1\)/);
    await page.getByRole('combobox',{name:'Tool'}).click(); await page.getByRole('option',{name:'select',exact:true}).click();
    await page.getByRole('button',{name:'Fit',exact:true}).click();
    const beforeMove=await featureBox('shelf'); await moveFeature('shelf',10,10); const afterMove=await featureBox('shelf'); assert.notDeepEqual(afterMove,beforeMove,'shelf move must change its rendered position');
    await resizeFeature('shelf',10,10);
    const beforePartitionMove=await featureBox('partition'); await moveFeature('partition',10,10); const afterPartitionMove=await featureBox('partition'); assert.notDeepEqual(afterPartitionMove,beforePartitionMove,'partition move must change its rendered position');
    await resizeFeature('partition',10,10);
    await page.getByTestId('feature-door').click();
    for (const [key,value] of [['x','330'],['y','400'],['width','120'],['height','250']]) await page.getByLabel(`${key} (mm)`,{exact:true}).fill(value);
    for (const [key,value] of [['width','650'],['height','850'],['depth','450']]) await page.getByLabel(`Cabinet ${key} (mm)`,{exact:true}).fill(value);
    await page.getByRole('button',{name:'Undo',exact:true}).last().click();
    assert.match(await svg.locator('text').textContent(),/depth 400 mm/,'undo must restore the prior cabinet depth');
    await page.getByRole('button',{name:'Redo',exact:true}).last().click();
    assert.match(await svg.locator('text').textContent(),/depth 450 mm/,'redo must restore the exact cabinet depth');
    const pending=page.waitForResponse(r=>r.url().includes(`/cabinets/${cabinet.id}`)&&r.request().method()==='PATCH');
    await page.getByTestId('save-structure-button').click(); const savedResponse=await pending; assert.equal(savedResponse.status(),200,`structure save HTTP ${savedResponse.status()}`);
    await page.getByRole('img',{name:'Cabinet structure drawing'}).waitFor({state:'visible',timeout:15000});
    await screenshot(page,'live-structure-exercise-saved.png');
    let persisted=await readCabinet(); assert.ok(persisted.structure,'saved structure absent from cabinet API');
    const expected=persisted.structure; assert.deepEqual(expected.features.map(f=>f.type).sort(),['door','opening','panel','partition','shelf']);
    const stale=await req('patch',cabinetUrl,{structure:expected},{'If-Match':String(baseline.revision)});
    assert.equal(stale.status(),412,`stale revision PATCH HTTP ${stale.status()}`);
    const afterStale=await readCabinet(); assert.equal(afterStale.revision,persisted.revision,'stale revision altered cabinet revision'); assert.deepEqual(afterStale.structure,expected,'stale revision altered structure');
    assert.equal(expected.envelope.width,650,'exact cabinet width not persisted'); assert.equal(expected.envelope.height,850,'exact cabinet height not persisted'); assert.equal(expected.envelope.depth,450,'exact cabinet depth not persisted');
    const partition=expected.features.find(f=>f.type==='partition'); assert.ok(partition.x>40&&partition.y>40&&partition.width>20&&partition.height>20,'partition move/resize not persisted');
    const shelf=expected.features.find(f=>f.type==='shelf'); assert.ok(shelf.x>80&&shelf.y>100&&shelf.width>480&&shelf.height>20,'shelf move/resize not persisted');
    const door=expected.features.find(f=>f.type==='door'); assert.deepEqual({x:door.x,y:door.y,width:door.width,height:door.height},{x:330,y:400,width:120,height:250},'exact door dimensions not persisted');
    assert.equal(persisted.width_units,baseline.width_units); assert.equal(persisted.height_units,baseline.height_units);
    await assertLayoutPreserved(persisted.revision);
    await page.reload({waitUntil:'domcontentloaded'}); await page.getByTestId('cabinet-designer').waitFor({timeout:30000}); await page.getByRole('tab',{name:'Cabinet / Structure',exact:true}).click();
    await page.getByTestId('feature-partition').waitFor({state:'visible'}); await page.getByRole('img',{name:'Cabinet structure drawing'}).waitFor({state:'visible',timeout:15000}); await screenshot(page,'live-structure-exercise-refreshed.png');
    persisted=await readCabinet(); assert.deepEqual(persisted.structure,expected,'structure differs after refresh');
    assert.equal(persisted.width_units,baseline.width_units); assert.equal(persisted.height_units,baseline.height_units);
    await assertLayoutPreserved(persisted.revision);
    if (restart) {
      execFileSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','inventree-deploy@mainserver-1','inventree-deploy','restart'],{encoding:'utf8',timeout:120000,stdio:['ignore','ignore','ignore']});
      let healthy=false; for(let i=0;i<60;i++){try{if((await context.request.get(`${base}/api/`,{timeout:5000})).status()===200){healthy=true;break;}}catch{} await page.waitForTimeout(2000);}
      assert.ok(healthy,'Development API did not recover after restricted restart'); await page.reload({waitUntil:'domcontentloaded',timeout:60000}); await page.getByTestId('cabinet-designer').waitFor({timeout:60000}); await page.getByRole('tab',{name:'Cabinet / Structure',exact:true}).click();
      await page.getByTestId('feature-partition').waitFor({state:'visible',timeout:60000}); await page.getByRole('img',{name:'Cabinet structure drawing'}).waitFor({state:'visible',timeout:15000});
      persisted=await readCabinet(); assert.deepEqual(persisted.structure,expected,'structure differs after restricted restart'); await assertLayoutPreserved(persisted.revision);
      await screenshot(page,'live-structure-exercise-after-restart.png');
    }
    console.log(`EXERCISE PASS cabinet=${cabinet.id}; structure persisted across refresh${restart?' and restricted Development restart':''}; logical dimensions and layout unchanged.`);
    console.log('Fixture retained for audit; no cleanup endpoint is used. No hardware, Main or deployment action was performed.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(`${error.name}: ${error.message}`);process.exitCode=1;});
