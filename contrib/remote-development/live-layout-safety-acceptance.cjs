#!/usr/bin/env node
/* Dev-only live API acceptance for non-admin denial and stock-preserving layout edits. */
const { chromium } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = process.env.SL_BASE_URL || 'http://192.168.1.108:18081';
assert.equal(base, 'http://192.168.1.108:18081', 'restricted to approved Development');
const api = '/plugin/storage-layout/api/v1/';
const redacted = (text, secrets) => secrets.reduce((s, secret) => secret ? s.replaceAll(secret, '[REDACTED]') : s, text);
const report = (label, status, expected) => {
  const ok = Array.isArray(expected) ? expected.includes(status) : status === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} HTTP ${status}`);
  return ok;
};
const remote = command => execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','spetchal@mainserver-1',command], {encoding:'utf8',timeout:30000}).trim();
(async () => {
  const password = remote("sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\"");
  assert.ok(password);
  const browser = await chromium.launch({headless:true,...(process.env.SL_CHROMIUM_PATH ? {executablePath:process.env.SL_CHROMIUM_PATH}: {})});
  try {
    const context = await browser.newContext(), page = await context.newPage();
    await page.goto(`${base}/web/login`, {waitUntil:'domcontentloaded'});
    await page.getByLabel('login-username').fill('sl_admin');
    await page.getByLabel('login-password').fill(password);
    await page.getByRole('button',{name:'Log In',exact:true}).click();
    await page.getByLabel('navigation-menu').waitFor({timeout:45000});
    const csrf = (await context.cookies()).find(c => c.name === 'csrftoken')?.value;
    assert.ok(csrf);
    const headers = {'X-CSRFToken':csrf, Referer:`${base}/web/`};
    const req = (method,path,data,extra={}) => context.request[method](base+path,{headers:{...headers,...extra},...(data===undefined?{}:{data})});
    // Remove only known IDs from prior runs after verifying the generated disposable username prefix.
    for (const priorId of [3,4,5,6,7,8,9]) {
      const prior=await req('get',`/api/user/${priorId}/`);
      if(prior.status()===200){const account=await prior.json();if(/^sl_safety_[a-f0-9]{20}$/.test(account.username||'')){const removed=await req('delete',`/api/user/${priorId}/`);report(`clean prior disposable user ${priorId}`,removed.status(),[200,204]);}}
    }
    const check = async (label,response,expected) => {
      report(label,response.status(),expected);
      if (!((Array.isArray(expected) ? expected : [expected]).includes(response.status()))) {
        const body = await response.text();
        console.log(`RESPONSE ${label} ${redacted(body.slice(0,700),[password])}`);
      }
      assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status()), `${label}: unexpected HTTP ${response.status()}`);
      return response;
    };
    const uuid = crypto.randomUUID(), fixture = `SL safety ${uuid}`;
    const username = `sl_safety_${uuid.replaceAll('-','').slice(0,20)}`;
    const userPassword = `T-${crypto.randomBytes(24).toString('base64url')}-9a`;
    const userResult = await req('post','/api/user/',{username,password:userPassword,email:`${username}@invalid.example`,first_name:'Disposable',last_name:'Acceptance',is_staff:false,is_superuser:false,is_active:true});
    if (!report('create disposable non-admin user via normal admin API',userResult.status(),201)) {
      const detail = redacted((await userResult.text()).slice(0,700),[password,userPassword]);
      console.log(`BLOCKER user creation unavailable through normal API; HTTP ${userResult.status()} ${detail}`);
      return;
    }
    const user = await userResult.json();
    assert.equal(user.username,username);
    assert.equal(user.is_staff,false);
    assert.equal(user.is_superuser,false);
    console.log(`FIXTURE disposable_user_id=${user.pk ?? user.id}`);

    const restricted = await browser.newContext();
    // Use the supported session login form for a genuine browser session and CSRF cookie.
    const restrictedPage = await restricted.newPage();
    let browserLoginStatus=0, browserLoginDiagnostic='';
    restrictedPage.on('response',async response=>{if(/login|token/i.test(response.url())&&response.request().method()==='POST'){browserLoginStatus=response.status();try{browserLoginDiagnostic=redacted((await response.text()).slice(0,700),[password,userPassword]);}catch{}}});
    await restrictedPage.goto(`${base}/web/login`,{waitUntil:'domcontentloaded'});
    await restrictedPage.getByLabel('login-username').fill(username);
    await restrictedPage.getByLabel('login-password').fill(userPassword);
    await restrictedPage.getByRole('button',{name:'Log In',exact:true}).click();
    let userReq=null, permissionSessionReady=true;
    try { await restrictedPage.getByLabel('navigation-menu').waitFor({timeout:20000}); }
    catch {
      permissionSessionReady=false;
      report('non-admin browser session established',browserLoginStatus,200);
      console.log(`LOGIN validation response ${browserLoginDiagnostic || '[empty response body]'}`);
      console.log('BLOCKER could not establish browser session for disposable account; permission mutation probes skipped; continuing independent stock acceptance');
    }
    if(permissionSessionReady){
      const userCsrf = (await restricted.cookies()).find(c=>c.name==='csrftoken')?.value;
      assert.ok(userCsrf);
      const userHeaders = {'X-CSRFToken':userCsrf,Referer:`${base}/web/`};
      userReq = (method,path,data,extra={}) => restricted.request[method](base+path,{headers:{...userHeaders,...extra},...(data===undefined?{}:{data})});
    }

    const cabinetResponse = await check('create disposable cabinet/root',await req('post',api+'cabinets/',{name:fixture,slug:`sl-safe-${uuid}`,root_location_name:fixture,width_units:500,height_units:500}),201);
    const cabinet = await cabinetResponse.json(), cabinetPath=`${api}cabinets/${cabinet.id}/layout/`;
    let layoutResponse=await check('read fixture layout',await req('get',cabinetPath),200), layout=await layoutResponse.json();
    const drawerId=crypto.randomUUID();
    layout={...layout,drawers:[...layout.drawers,{id:drawerId,is_new:true,label:`Safety drawer ${uuid}`,display_number:1,location:null,auto_create_location:true,x:0,y:0,width:240,height:240,interior_width:220,interior_height:220}]};
    layoutResponse=await check('create disposable drawer and location',await req('put',cabinetPath,layout,{'If-Match':String(layoutResponse.headers().etag||'').replaceAll('"','')}),200);
    const savedCabinet=await (await req('get',cabinetPath)).json(), drawer=savedCabinet.drawers.find(d=>d.id===drawerId);
    assert.ok(drawer?.location);
    const drawerPath=`${api}drawers/${drawerId}/layout/`;
    let drawerResponse=await check('read drawer layout',await req('get',drawerPath),200), drawerDoc=await drawerResponse.json();
    const bin={id:null,drawer:drawerId,label:`Safety bin ${uuid}`,location:null,auto_create_location:true,x:10,y:10,width:80,height:80};
    drawerResponse=await check('create disposable bin/location',await req('put',drawerPath,{...drawerDoc,bins:[...drawerDoc.bins,bin]},{'If-Match':String(drawerResponse.headers().etag||'').replaceAll('"','')}),200);
    drawerDoc=await (await req('get',drawerPath)).json();
    const savedBin=drawerDoc.bins.find(b=>b.label===bin.label); assert.ok(savedBin?.location);

    const getLocations=async()=>{const r=await check('read stock locations',await req('get','/api/stock/location/'),200);const data=await r.json();return {items:Array.isArray(data)?data:data.results,count:data.count};};
    const initialLocations=await getLocations();
    const getLayoutRevision=async()=>{const r=await req('get',cabinetPath);assert.equal(r.status(),200);return Number(String(r.headers().etag||'').replaceAll('"',''));};
    const initialRevision=Number(String((await req('get',cabinetPath)).headers().etag||'').replaceAll('"',''));
    const initialCount=initialLocations.count ?? initialLocations.items.length;
    const revisionProbe=await getLayoutRevision(); assert.ok(revisionProbe>0);

    // Permission probes require a genuine browser session; stock preservation does not.
    if(permissionSessionReady){
      const deniedLayout=await userReq('put',cabinetPath,savedCabinet,{'If-Match':String(initialRevision)});
      report('non-admin cabinet layout mutation denied',deniedLayout.status(),[401,403]);
      const deniedLocation=await userReq('post','/api/stock/location/',{name:`Denied ${uuid}`,description:'disposable permission probe',structural:false});
      report('non-admin native location creation denied',deniedLocation.status(),[401,403]);
      const afterDeniedRevision=await getLayoutRevision(), afterDeniedLocations=await getLocations();
      assert.equal(afterDeniedRevision,initialRevision,'denied write did not advance layout revision');
      assert.equal(afterDeniedLocations.count??afterDeniedLocations.items.length,initialCount,'denied create did not change location count');
      console.log('PASS denied attempts left revision and location count unchanged');
    }

    // Stock creation is intentionally isolated to this newly created bin. If the native APIs
    // do not support a safe disposable part/stock workflow, record that as a blocker, not a pass.
    const categoryResponse=await req('get','/api/part/category/');
    if(categoryResponse.status()!==200){report('read part categories',categoryResponse.status(),200);console.log('BLOCKER cannot safely create disposable stock without a category');return;}
    const categories=await categoryResponse.json(), categoryList=Array.isArray(categories)?categories:categories.results;
    let category=categoryList?.find(c=>c.pk??c.id);
    let createdCategory=null;
    if(!category){
      const categoryCreate=await req('post','/api/part/category/',{name:`${fixture} category`,description:'Disposable live acceptance fixture'});
      if(!report('create disposable part category via normal API',categoryCreate.status(),201)){console.log(`BLOCKER category creation unavailable HTTP ${categoryCreate.status()} ${redacted((await categoryCreate.text()).slice(0,600),[password,userPassword])}`);return;}
      createdCategory=await categoryCreate.json(); category=createdCategory;
    }
    const partResponse=await req('post','/api/part/',{name:`${fixture} part`,IPN:`SL-${uuid}`,description:'Disposable live acceptance fixture',category:category.pk??category.id,active:true});
    if(!report('create disposable part via normal API',partResponse.status(),201)){console.log(`BLOCKER part creation response HTTP ${partResponse.status()} ${redacted((await partResponse.text()).slice(0,700),[password,userPassword])}`);return;}
    const part=await partResponse.json();
    const stockResponse=await req('post','/api/stock/',{part:part.pk??part.id,location:savedBin.location,quantity:7});
    if(!report('populate disposable bin with stock quantity 7',stockResponse.status(),201)){console.log(`BLOCKER stock creation response HTTP ${stockResponse.status()} ${redacted((await stockResponse.text()).slice(0,700),[password,userPassword])}`);return;}
    const stockPayload=await stockResponse.json(), stock=Array.isArray(stockPayload)?stockPayload[0]:stockPayload;
    const stockId=stock?.pk??stock?.id??stock?.stock_item?.pk??stock?.stock_item?.id??stock?.item?.pk??stock?.item?.id;
    assert.ok(stockId,'stock create response must identify the disposable record');
    const stockReadPath=`/api/stock/${stockId}/`;
    const readStock=async(label)=>{const r=await check(label,await req('get',stockReadPath),200);const s=await r.json();return {id:s.pk??s.id,quantity:s.quantity,location:s.location};};
    const expectedStock=await readStock('baseline populated stock record');
    assert.equal(String(expectedStock.location),String(savedBin.location)); assert.equal(Number(expectedStock.quantity),7);
    const assertPreserved=async(label)=>{const now=await readStock(label);assert.deepEqual(now,expectedStock,`${label}: stock identity, quantity, or location changed`);};
    const saveCabinet=async(label,doc)=>{const r=await req('get',cabinetPath);assert.equal(r.status(),200);const current=await r.json();const changed=doc(current);await check(label,await req('put',cabinetPath,changed,{'If-Match':String(r.headers().etag||'').replaceAll('"','')}),200);};
    await saveCabinet('rename drawer and save',doc=>({...doc,drawers:doc.drawers.map(d=>d.id===drawerId?{...d,label:`Renamed drawer ${uuid}`} : d)}));
    await assertPreserved('stock unchanged after drawer rename');
    drawerResponse=await req('get',drawerPath); drawerDoc=await drawerResponse.json();
    await check('rename bin and save',await req('put',drawerPath,{...drawerDoc,bins:drawerDoc.bins.map(b=>b.id===savedBin.id?{...b,label:`Renamed bin ${uuid}`} : b)},{'If-Match':String(drawerResponse.headers().etag||'').replaceAll('"','')}),200);
    await assertPreserved('stock unchanged after bin rename');
    drawerResponse=await req('get',drawerPath); drawerDoc=await drawerResponse.json();
    await check('archive populated bin and save',await req('put',drawerPath,{...drawerDoc,bins:drawerDoc.bins.map(b=>b.id===savedBin.id?{...b,archived:true}:b)},{'If-Match':String(drawerResponse.headers().etag||'').replaceAll('"','')}),200);
    await assertPreserved('stock unchanged after bin archive');
    drawerResponse=await req('get',drawerPath); drawerDoc=await drawerResponse.json();
    await check('repeated archived layout save',await req('put',drawerPath,drawerDoc,{'If-Match':String(drawerResponse.headers().etag||'').replaceAll('"','')}),200);
    await assertPreserved('stock unchanged after repeated save');
    const locationsAfter=await getLocations();
    assert.ok(locationsAfter.items.some(l=>String(l.pk)===String(savedBin.location)),'populated bin native location still exists');
    console.log(`FIXTURE cabinet=${cabinet.id} drawer=${drawerId} bin=${savedBin.id} location=${savedBin.location} part=${part.pk??part.id} stock=${stockId} user=${user.pk??user.id}`);
    const cleanup=await req('delete',`/api/user/${user.pk??user.id}/`);
    report('delete positively identified disposable user',cleanup.status(),[200,204]);
    await restricted.close();
  } finally { await browser.close(); }
})().catch(error=>{console.error(`${error.name}: ${error.message}`);process.exitCode=1;});
