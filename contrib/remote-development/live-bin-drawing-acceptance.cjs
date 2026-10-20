#!/usr/bin/env node
/* Isolated live browser acceptance for current drawer bin drawing UI. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = process.env.SL_BASE_URL || 'http://192.168.1.108:18081';
assert.equal(base, 'http://192.168.1.108:18081', 'restricted to approved Development');
const api = '/plugin/storage-layout/api/v1/';
const report = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` ${detail}` : ''}`);
const remote = (command) => execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','spetchal@mainserver-1',command], {encoding:'utf8',timeout:30000}).trim();
(async () => {
  const password = remote("sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\"");
  assert.ok(password);
  const browser = await chromium.launch({headless:true,...(process.env.SL_CHROMIUM_PATH ? {executablePath:process.env.SL_CHROMIUM_PATH}: {})});
  try {
    const context = await browser.newContext({viewport:{width:1600,height:1100}}), page = await context.newPage();
    let loginStatus = 0;
    page.on('response', r => { if (/login|token/i.test(r.url()) && r.request().method()==='POST') loginStatus=r.status(); });
    let loggedIn = false;
    for (let attempt=1; attempt<=3 && !loggedIn; attempt++) {
      await page.goto(`${base}/web/login`, {waitUntil:'domcontentloaded'});
      if (!page.url().includes('/login')) { await page.goto(`${base}/web/login`, {waitUntil:'domcontentloaded'}); }
      const user = page.getByLabel('login-username'), pass = page.getByLabel('login-password');
      await user.waitFor({timeout:15000}); await user.fill('sl_admin'); await pass.fill(password);
      await page.getByRole('button',{name:'Log In',exact:true}).click();
      try { await page.getByLabel('navigation-menu').waitFor({timeout:25000}); loggedIn=true; }
      catch { console.log(`LOGIN attempt=${attempt} status=${loginStatus} url=${new URL(page.url()).pathname} authDom=${(await page.locator('body').innerText()).slice(0,180).replace(/\s+/g,' ')}`); if(attempt<3) await page.waitForTimeout(10000*attempt); }
    }
    assert.ok(loggedIn, `login failed after bounded retries (last POST status ${loginStatus})`);
    const csrf=(await context.cookies()).find(c=>c.name==='csrftoken')?.value; assert.ok(csrf);
    const headers={'X-CSRFToken':csrf,Referer:`${base}/web/`};
    const req=(method,path,data,extra={})=>context.request[method](base+path,{headers:{...headers,...extra},...(data===undefined?{}:{data})});
    const must=async(label,r,status)=>{report(label,r.status()===status,`HTTP ${r.status()}`);if(r.status()!==status){const body=await r.json().catch(()=>null);const detail=body?.detail??body?.error??body?.message??null;if(typeof detail==='string')console.log(`API detail ${detail.replaceAll(password,'[REDACTED]').slice(0,500)}`);else if(body&&typeof body==='object')console.log(`API error ${JSON.stringify(body).replaceAll(password,'[REDACTED]').slice(0,800)}`);}assert.equal(r.status(),status,label);return r;};
    const uuid=crypto.randomUUID(), name=`SL bin drawing ${uuid}`;
    const rootResp=await must('create isolated cabinet/root',await req('post',api+'cabinets/',{name,slug:`sl-bindraw-${uuid}`,root_location_name:name,width_units:500,height_units:500}),201);
    const cabinet=await rootResp.json(), layoutPath=`${api}cabinets/${cabinet.id}/layout/`;
    let layoutResp=await must('read initial cabinet layout',await req('get',layoutPath),200), layout=await layoutResp.json();
    await page.goto(`${base}/web/plugin/storage-layout/cabinets/${cabinet.id}/design`);
    await page.getByTestId('cabinet-designer').waitFor({timeout:30000});
    await page.getByRole('button',{name:'Add drawer',exact:true}).click();
    let pending=page.waitForResponse(r=>r.url().includes(`/cabinets/${cabinet.id}/layout/`)&&r.request().method()==='PUT');
    await page.getByLabel('Save layout',{exact:true}).click(); await must('save drawer through UI',await pending,200);
    layoutResp=await must('read saved drawer',await req('get',layoutPath),200); layout=await layoutResp.json();
    const drawer=layout.drawers.find(d=>d.location); assert.ok(drawer,'UI drawer persisted with auto-created location');
    const locationsResp=await must('read native locations',await req('get','/api/stock/location/'),200); const locationPayload=await locationsResp.json(); let locations=Array.isArray(locationPayload)?locationPayload:locationPayload.results;
    const cabinetLoc=locations.find(x=>String(x.pk)===String(cabinet.location)), drawerLoc=locations.find(x=>String(x.pk)===String(drawer.location));
    assert.ok(cabinetLoc&&drawerLoc); assert.equal(String(drawerLoc.parent),String(cabinetLoc.pk)); assert.equal(drawerLoc.structural,true);
    report('drawer auto-location parent and structural flag',true);
    await page.goto(`${base}/web/plugin/storage-layout/drawers/${drawer.id}/design`);
    await page.getByTestId('drawer-designer').waitFor({timeout:30000});
    const canvas=page.getByRole('application',{name:/drawer top-down view/i}); await canvas.waitFor({state:'visible'});
    await page.getByRole('button',{name:'Draw mode',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Draw mode',exact:true}).getAttribute('aria-pressed'),'true');
    const drawPoints=await canvas.evaluate((node, dimensions)=>{const group=node.querySelector('g[transform]'),matrix=group?.getScreenCTM();if(!matrix)throw Error('drawer canvas transform unavailable');const point=(x,y)=>{const p=new DOMPoint(x,y).matrixTransform(matrix);return{x:p.x,y:p.y};};return[point(dimensions.width*.12,dimensions.height*.12),point(dimensions.width*.52,dimensions.height*.52)];},{width:drawer.interior_width,height:drawer.interior_height});
    await page.mouse.move(drawPoints[0].x,drawPoints[0].y); await page.mouse.down();
    await page.mouse.move(drawPoints[1].x,drawPoints[1].y,{steps:12}); await page.mouse.up();
    assert.equal(await page.getByTestId('bin-list').locator('button').count(),1,'drag creates a bin'); report('draw bin via current canvas mode',true);
    const inspector=page.getByTestId('bin-inspector'); await inspector.waitFor({timeout:10000});
    const locField=inspector.getByLabel('Stock location',{exact:true});
    const save=async label=>{const p=page.waitForResponse(r=>r.url().includes(`/drawers/${drawer.id}/layout/`)&&r.request().method()==='PUT');await page.getByRole('button',{name:'Save layout',exact:true}).click();await must(label,await p,200);};
    pending=page.waitForResponse(r=>r.url().includes(`/drawers/${drawer.id}/layout/`)&&r.request().method()==='PUT'); await page.getByRole('button',{name:'Save layout',exact:true}).click(); await must('save drawn bin with automatic location',await pending,200);
    let dr=await must('read persisted bin',await req('get',`${api}drawers/${drawer.id}/layout/`),200), doc=await dr.json();
    assert.equal(doc.bins.length,1); let bin=doc.bins[0]; assert.ok(bin.location);
    {const locationPayload=await (await must('verify bin native location',await req('get','/api/stock/location/'),200)).json(); locations=Array.isArray(locationPayload)?locationPayload:locationPayload.results;}
    const binLoc=locations.find(x=>String(x.pk)===String(bin.location)); assert.ok(binLoc); assert.equal(String(binLoc.parent),String(drawer.location)); assert.equal(binLoc.structural,false); report('bin automatic native-location correct parent',true);
    const stableIds={drawer:drawer.location,bin:bin.location}, count=locations.length;
    await save('repeat UI save'); doc=await (await must('read after repeated save',await req('get',`${api}drawers/${drawer.id}/layout/`),200)).json();
    assert.equal(doc.bins[0].location,stableIds.bin); {const locationPayload=await (await req('get','/api/stock/location/')).json();locations=Array.isArray(locationPayload)?locationPayload:locationPayload.results;} assert.equal(locations.length,count); report('repeat save preserves IDs without duplicate locations',true);
    const readBin=async()=>{const r=await must('read bin geometry',await req('get',`${api}drawers/${drawer.id}/layout/`),200);return (await r.json()).bins[0];};
    const screenRect=async()=>page.locator('svg g > rect[style]').evaluateAll(nodes=>{const n=nodes.find(x=>x.style.cursor==='move');if(!n)throw Error('draggable bin SVG rectangle not found');const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2,w:b.width,h:b.height};});
    let before=await readBin(), box=await screenRect(); await page.mouse.move(box.x,box.y); await page.mouse.down(); await page.mouse.move(box.x+box.w/Number(before.width)*10,box.y+box.h/Number(before.height)*10,{steps:8}); await page.mouse.up(); await save('save moved bin'); let moved=await readBin(); assert.notDeepEqual([moved.x,moved.y],[before.x,before.y]); report('drag move persists changed bin coordinates',true);
    box=await screenRect(); await page.mouse.click(box.x,box.y); const handle=await page.locator('svg rect[style]').evaluateAll(nodes=>{const n=nodes.find(x=>x.style.cursor==='se-resize');if(!n)throw Error('resize handle not found');const b=n.getBoundingClientRect();return{x:b.x+b.width/2,y:b.y+b.height/2};}); const scale=await canvas.evaluate(n=>n.querySelector('g[transform]')?.getScreenCTM()?.a); assert.ok(scale>0);
    await page.mouse.move(handle.x,handle.y); await page.mouse.down(); await page.mouse.move(handle.x+5*scale,handle.y+5*scale,{steps:8}); await page.mouse.up(); await save('save resized bin'); let resized=await readBin(); assert.ok(Number(resized.width)>Number(moved.width)&&Number(resized.height)>Number(moved.height)); report('drag resize persists larger bin',true);
    // Exercise history as UI actions, then restore and save the desired resized state.
    const undo=page.getByRole('button',{name:/undo/i}), redo=page.getByRole('button',{name:/redo/i});
    await undo.click(); await redo.click(); await save('save after undo/redo'); doc=await (await req('get',`${api}drawers/${drawer.id}/layout/`)).json(); assert.equal(String(doc.bins[0].location),String(stableIds.bin)); report('undo/redo retains bin identity',true);
    const beforeRefresh={x:doc.bins[0].x,y:doc.bins[0].y,width:doc.bins[0].width,height:doc.bins[0].height}; await page.reload(); await page.getByTestId('drawer-designer').waitFor({timeout:30000}); doc=await (await req('get',`${api}drawers/${drawer.id}/layout/`)).json(); assert.deepEqual({x:doc.bins[0].x,y:doc.bins[0].y,width:doc.bins[0].width,height:doc.bins[0].height},beforeRefresh); report('refresh persistence',true);
    const cabinetRead=await must('read fixture before collision rollback',await req('get',layoutPath),200), cabinetDoc=await cabinetRead.json();
    const collisionDoc={...cabinetDoc,drawers:[...cabinetDoc.drawers,{...cabinetDoc.drawers[0],id:crypto.randomUUID(),is_new:true,display_number:Math.max(...cabinetDoc.drawers.map(d=>d.display_number))+1,location:null,auto_create_location:true,x:cabinetDoc.drawers[0].x+cabinetDoc.drawers[0].width+10}],bins:cabinetDoc.bins};
    const beforeCollisionPayload=await (await req('get','/api/stock/location/')).json(), preCollisionLocations=Array.isArray(beforeCollisionPayload)?beforeCollisionPayload:beforeCollisionPayload.results;
    const collision=await req('put',layoutPath,collisionDoc,{'If-Match':String(cabinetRead.headers().etag||'').replaceAll('"','')}); report('duplicate native drawer label rejected', [400,409].includes(collision.status()),`HTTP ${collision.status()}`); assert.ok([400,409].includes(collision.status()));
    const afterCollisionRead=await must('verify collision rollback revision',await req('get',layoutPath),200),afterCollision=await afterCollisionRead.json(); assert.equal(afterCollision.revision,cabinetDoc.revision); const afterCollisionLocationsPayload=await (await req('get','/api/stock/location/')).json(),afterCollisionLocations=Array.isArray(afterCollisionLocationsPayload)?afterCollisionLocationsPayload:afterCollisionLocationsPayload.results; assert.equal(afterCollisionLocations.length,preCollisionLocations.length); report('collision rollback leaves revision and location count unchanged',true);
    const snapshot=async()=>{const c=await (await req('get',layoutPath)).json(),d=await (await req('get',`${api}drawers/${drawer.id}/layout/`)).json();return{cabinetRevision:c.revision,drawer:d.drawer,bins:d.bins};};
    const beforeRestart=await snapshot();
    execFileSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','inventree-deploy@mainserver-1','inventree-deploy','restart'],{encoding:'utf8',timeout:120000,stdio:['ignore','ignore','ignore']});
    let healthy=false; for(let attempt=0;attempt<60;attempt++){try{const h=await context.request.get(`${base}/api/`,{timeout:5000});if(h.status()===200){healthy=true;break;}}catch{} await page.waitForTimeout(2000);} assert.ok(healthy,'API health after restricted restart'); await page.reload({waitUntil:'domcontentloaded',timeout:60000}); await page.getByTestId('drawer-designer').waitFor({timeout:60000}); assert.deepEqual(await snapshot(),beforeRestart); report('restricted restart persistence',true);
    console.log(`FIXTURE cabinet=${cabinet.id} drawer=${drawer.id} drawer_location=${stableIds.drawer} bin_location=${stableIds.bin}`);
    await context.close();
  } finally { await browser.close(); }
})().catch(error=>{console.error(`${error.name}: ${error.message}`);process.exitCode=1;});
