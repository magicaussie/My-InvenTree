#!/usr/bin/env node
/* Isolated Development-only automatic native location creation acceptance. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = process.env.SL_BASE_URL || 'http://192.168.1.108:18081';
assert.equal(base, 'http://192.168.1.108:18081', 'Acceptance is restricted to approved Development');
const api = '/plugin/storage-layout/api/v1/';
const report = (label, status, pass) => console.log(`${pass ? 'PASS' : 'FAIL'} ${label} HTTP ${status}`);
(async () => {
  const password = execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','spetchal@mainserver-1', "sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\""], { encoding:'utf8', timeout:30000 }).trim();
  assert.ok(password);
  const browser = await chromium.launch({headless:true,...(process.env.SL_CHROMIUM_PATH ? {executablePath:process.env.SL_CHROMIUM_PATH}: {})});
  try {
    const context = await browser.newContext({viewport:{width:1500,height:1000}});
    const page = await context.newPage();
    await page.goto(`${base}/web/login`);
    await page.getByLabel('login-username').fill('sl_admin');
    await page.getByLabel('login-password').fill(password);
    await page.getByRole('button',{name:'Log In',exact:true}).click();
    await page.getByLabel('navigation-menu').waitFor({timeout:45000});
    const csrf=(await context.cookies()).find(c=>c.name==='csrftoken')?.value; assert.ok(csrf);
    const headers={'X-CSRFToken':csrf,Referer:`${base}/web/`};
    const req=async(method,path,data,extra={})=>context.request[method](base+path,{headers:{...headers,...extra},...(data===undefined?{}:{data})});
    const check=async(label,r,expected=200)=>{ report(label,r.status(),r.status()===expected); assert.equal(r.status(),expected,label); return r; };
    const uuid=crypto.randomUUID(), name=`SL automatic acceptance ${uuid}`;
    const cr=await check('create cabinet with automatic root',await req('post',api+'cabinets/',{name,slug:`sl-auto-${uuid}`,root_location_name:name,width_units:500,height_units:500}),201);
    const cabinet=await cr.json(), layoutPath=`${api}cabinets/${cabinet.id}/layout/`;
    const locs=async()=>{const r=await check('list native locations',await req('get','/api/stock/location/'));const b=await r.json();return b.results||b;};
    const root=(await locs()).find(x=>String(x.pk)===String(cabinet.location)); assert.ok(root); assert.equal(root.parent,null);
    const gr=await check('get initial layout',await req('get',layoutPath)); const initial=await gr.json(); const initialRev=Number((gr.headers().etag||'').replaceAll('\"','')); assert.ok(Number.isFinite(initialRev)&&initialRev>0,'layout ETag revision available');
    const drawerId=crypto.randomUUID(), drawer={id:drawerId,is_new:true,label:'Automatic drawer API',display_number:1,location:null,auto_create_location:true,x:0,y:0,width:200,height:200,interior_width:180,interior_height:180};
    const bin={id:null,drawer:drawerId,label:'Automatic bin API',location:null,auto_create_location:true,x:0,y:0,width:80,height:80};
    const put=(doc,rev)=>req('put',layoutPath,doc,{'If-Match':String(rev)});
    const first=await check('API automatic drawer/bin save',await put({...initial,drawers:[drawer],bins:[bin]},initialRev),200);
    let saved=await (await req('get',layoutPath)).json();
    const sd=saved.drawers.find(d=>d.id===drawerId), sb=saved.bins.find(b=>b.drawer===drawerId); assert.ok(sd?.location);assert.ok(sb?.location);
    let all=await locs();const dl=all.find(x=>String(x.pk)===String(sd.location)),bl=all.find(x=>String(x.pk)===String(sb.location));
    assert.equal(String(dl.parent),String(cabinet.location));assert.equal(String(bl.parent),String(sd.location));assert.equal(dl.structural,true);assert.equal(bl.structural,false);
    const count=all.length;let savedRead=await req('get',layoutPath);let savedRev=Number((savedRead.headers().etag||'').replaceAll('\"',''));saved=await savedRead.json();await check('API repeated save stable',await put(saved,savedRev),200);savedRead=await req('get',layoutPath);savedRev=Number((savedRead.headers().etag||'').replaceAll('\"',''));saved=await savedRead.json();
    assert.equal(saved.drawers.find(d=>d.id===drawerId).location,sd.location);assert.equal(saved.bins.find(b=>b.drawer===drawerId).location,sb.location);assert.equal((await locs()).length,count);
    console.log('PASS API auto-create root/drawer/bin hierarchy, flags, stable IDs, and no duplicate locations');

    // Duplicate drawer labels are a genuine layout collision. The transaction must reject it
    // without advancing revision or creating an automatic native location.
    const collisionDoc={...saved,drawers:[...saved.drawers,{...saved.drawers[0],id:crypto.randomUUID(),is_new:true,label:saved.drawers[0].label,display_number:2,location:null,auto_create_location:true,x:220}],bins:saved.bins};
    const preCollisionCount=(await locs()).length, collisionRev=savedRev;
    const collision=await put(collisionDoc,collisionRev); report('duplicate drawer identity collision rejected',collision.status(),[400,409].includes(collision.status())); assert.ok([400,409].includes(collision.status()));
    const collisionRead=await req('get',layoutPath), afterCollision=await collisionRead.json();const afterCollisionRev=Number((collisionRead.headers().etag||'').replaceAll('\"',''));assert.equal(afterCollisionRev,collisionRev);assert.equal((await locs()).length,preCollisionCount);console.log('PASS collision rollback: revision and native-location count unchanged');

    // Two concurrent writes with identical If-Match: exactly one wins; its sibling is stale.
    const concurrentBase=afterCollision, rev=afterCollisionRev;
    const concurrentDoc1={...concurrentBase,drawers:[...concurrentBase.drawers,{...drawer,id:crypto.randomUUID(),label:'Concurrent A',display_number:2,x:220}]};
    const concurrentDoc2={...concurrentBase,drawers:[...concurrentBase.drawers,{...drawer,id:crypto.randomUUID(),label:'Concurrent B',display_number:2,x:220}]};
    const results=await Promise.all([put(concurrentDoc1,rev),put(concurrentDoc2,rev)]);
    results.forEach((r,i)=>report(`competing save ${i+1}`,r.status(),[200,412].includes(r.status())));
    assert.deepEqual(results.map(r=>r.status()).sort((a,b)=>a-b),[200,412]);
    let currentRead=await req('get',layoutPath);let currentRev=Number((currentRead.headers().etag||'').replaceAll('\"',''));const current=await currentRead.json();
    // Separate stale request is an expected precondition outcome, not a test failure.
    const stale=await put(current,rev);report('stale revision rejected',stale.status(),stale.status()===412);assert.equal(stale.status(),412);

    // Unauthenticated write must not mutate the fixture. A fresh context has no session.
    const anonymous=await browser.newContext();const anon=await anonymous.request.put(base+layoutPath,{headers:{'If-Match':String(currentRev)},data:current});
    report('anonymous layout write denied',anon.status(),[401,403].includes(anon.status()));assert.ok([401,403].includes(anon.status()));await anonymous.close();
    const afterAnon=await (await req('get',layoutPath)).json();const verifyAnon=await req('get',layoutPath);assert.equal(Number(verifyAnon.headers().etag.replaceAll('\"','')),currentRev);

    // Real UI route: use toolbar Add drawer and Save layout; do not pre-create a drawer location.
    const uiId=crypto.randomUUID();
    await page.goto(`${base}/web/plugin/storage-layout/cabinets/${cabinet.id}/design`);
    await page.getByTestId('cabinet-designer').waitFor({timeout:30000});
    await page.getByRole('button',{name:'Add drawer',exact:true}).click();
    const pending=page.waitForResponse(r=>r.url().includes(`/cabinets/${cabinet.id}/layout/`)&&r.request().method()==='PUT');
    await page.getByLabel('Save layout',{exact:true}).click(); const uiResponse=await pending;report('frontend Add drawer + Save layout',uiResponse.status(),uiResponse.status()===200);assert.equal(uiResponse.status(),200);
    const uiSaved=await (await req('get',layoutPath)).json();
    const newDrawers=uiSaved.drawers.filter(d=>!current.drawers.some(old=>old.id===d.id));
    assert.ok(newDrawers.length>=1,'UI created persisted drawer');const uiDrawer=newDrawers[newDrawers.length-1];assert.ok(uiDrawer.location,'frontend-created drawer has automatic native location');
    all=await locs();const uiLoc=all.find(x=>String(x.pk)===String(uiDrawer.location));assert.ok(uiLoc);assert.equal(String(uiLoc.parent),String(cabinet.location));assert.equal(uiLoc.structural,true);
    console.log(`PASS real UI-created automatic drawer native_location=${uiDrawer.location}`);
    await context.close();
  } finally { await browser.close(); }
})().catch(error=>{console.error(`${error.name}: ${error.message}`);process.exitCode=1;});
