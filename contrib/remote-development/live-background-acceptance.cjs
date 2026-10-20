#!/usr/bin/env node
/* Real Development acceptance. Retains all fixtures; no deletion, traces or auth exports. */
const { chromium, expect } = require('../../src/frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const base = 'http://192.168.1.108:18081';
const api = '/plugin/storage-layout/api/v1/';
const resume = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2])) : null;
const securityResume = process.env.SL_BACKGROUND_SECURITY_RESUME === '1';
assert.ok(!securityResume || resume, 'security resume requires retained fixture report');
const run = securityResume ? crypto.randomUUID() : resume?.run ?? crypto.randomUUID();
assert.match(run, /^[0-9a-f-]{36}$/);
const out = `docs/storage-layout/evidence/background-${run}`;
fs.mkdirSync(out, { recursive: true });
const evidence = securityResume ? {run, base, application: process.env.SL_ACCEPTANCE_APPLICATION, fixture: resume.fixture, checks: [], http: [], snapshots: {}, screenshots: [], gaps: [], resumedFrom: process.argv[2]} : resume ?? { run, base, application: '56271a1ada6d531ac264cf6cfc98b7b6c9aecc8a', checks: [], http: [], snapshots: {}, screenshots: [], gaps: [] };
assert.equal(evidence.base, base);
assert.match(run, /^[0-9a-f-]{36}$/);
const write = () => fs.writeFileSync(`${out}/report.json`, JSON.stringify(evidence, null, 2));
const pass = label => { evidence.checks.push(label); console.log(`PASS ${label}`); write(); };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const remote = command => execFileSync('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','spetchal@mainserver-1',command], {encoding:'utf8',timeout:30000}).trim();
const secrets = [];
const redact = text => secrets.reduce((value,secret)=>value.replaceAll(secret,'[REDACTED]'),String(text));
let browser;
(async () => {
  const password = remote("sudo -n python3 -c \"from pathlib import Path; v=dict(line.split('=',1) for line in Path('/etc/myinventree-dev/runtime.env').read_text().splitlines()); print(v['SL_ADMIN_PASSWORD'])\"");
  secrets.push(password);
  browser = await chromium.launch({headless:true,...(process.env.SL_CHROMIUM_PATH ? {executablePath:process.env.SL_CHROMIUM_PATH}: {})});
  evidence.chromium = browser.version();
  const context = await browser.newContext({viewport:{width:1600,height:1100}});
  const blocked = [];
  await context.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin !== base || /\/(arm|disarm|stop|observe|discovery|pixel-tests|locate-sessions|import|approve-configuration)(\/|$)/.test(u.pathname)) {
      blocked.push(u.pathname); return route.abort();
    }
    return route.continue();
  });
  context.on('response',r=>{const path=new URL(r.url()).pathname;if(path.startsWith(api)) evidence.http.push({actor:'browser',method:r.request().method(),path,status:r.status(),etag:r.headers().etag});});
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const login = async (ctx, p, username, secret) => {
    await p.goto(`${base}/web/login`,{waitUntil:'domcontentloaded'});
    await p.getByLabel('login-username').fill(username);
    await p.getByLabel('login-password').fill(secret);
    await p.getByRole('button',{name:'Log In',exact:true}).click();
    await p.getByLabel('navigation-menu').waitFor({timeout:45000});
  };
  await login(context,page,'sl_admin',password); pass('authenticated real Development Chromium desktop');
  const csrf = (await context.cookies()).find(c=>c.name==='csrftoken')?.value; assert.ok(csrf);
  const headers = {'X-CSRFToken':csrf, Referer:base+'/web/'};
  const allowedWrites = new Set([api+'cabinets/','/api/part/category/','/api/part/','/api/stock/','/api/user/']);
  const req = async (method,path,data,extra={},multipart) => {
    assert.ok(path.startsWith('/')); assert.ok(!/\/(arm|disarm|stop|observe|discovery|pixel-tests|locate-sessions|import|approve-configuration)\//.test(path));
    assert.notEqual(method,'delete','no deletion authorized');
    if(method!=='get') assert.ok(allowedWrites.has(path),'writes only to explicitly registered fixtures');
    const r = await context.request[method](base+path,{headers:{...headers,...extra},...(multipart?{multipart}:data===undefined?{}:{data})});
    evidence.http.push({method,path,status:r.status(),etag:r.headers().etag}); write(); return r;
  };
  const must = async (r,status,label) => {assert.equal(r.status(),status,`${label}: HTTP ${r.status()} ${r.status()===status?'':redact(await r.text()).slice(0,800)}`); return r;};
  const get = async path => (await must(await req('get',path),200,path)).json();
  const create = async (path,data) => (await must(await req('post',path,data),201,`create ${path}`)).json();
  let cabinet, cp, lp, drawerIds, baseline;
  if (!resume) {
  cabinet = await create(api+'cabinets/',{name:`SL image acceptance ${run}`,slug:`sl-image-${run}`,root_location_name:`SL image isolated ${run}`,width_units:600,height_units:500});
  cp = api+`cabinets/${cabinet.id}/`; lp=cp+'layout/';
  [cp,lp,cp+'electrical/',cp+'mapping-publish/',cp+'background/'].forEach(p=>allowedWrites.add(p));
  evidence.fixture={cabinet:cabinet.id,root:cabinet.location,drawers:[]}; write();
  const cas = async (method,path,data,status=200) => {const r=await req('get',path);await must(r,200,'read CAS');return must(await req(method,path,data,{'If-Match':r.headers().etag}),status,`CAS ${path}`);};
  let doc=await get(lp);
  drawerIds=[crypto.randomUUID(),crypto.randomUUID()];
  doc.drawers=drawerIds.map((id,i)=>({id,is_new:true,label:`Image drawer ${i+1}`,display_number:i+1,location:null,auto_create_location:true,x:30+i*290,y:40,width:230,height:180,interior_width:300,interior_height:250,archived:false,allocation:null}));
  await cas('put',lp,doc);
  for(const id of drawerIds){
    const dp=api+`drawers/${id}/layout/`;allowedWrites.add(dp);allowedWrites.add(api+`drawers/${id}/background/`);
    const d=await get(dp);d.bins=[{id:null,is_new:true,drawer:id,label:'Reference bin',location:null,auto_create_location:true,x:30,y:30,width:80,height:70,archived:false}];
    await cas('put',dp,d);const saved=await get(dp); evidence.fixture.drawers.push({id,location:saved.drawer.location,bin:saved.bins[0]}); write();
  }
  pass('isolated cabinet, two distinct drawers and native-bin locations created via actual API');
  const electrical={schema_version:1,archive_ids:[],controllers:[{id:null,name:`Isolated no-contact ${run}`,origin:'http://192.0.2.1',enabled:false,outputs:[{id:null,bus_index:0,wled_start:0,pixel_count:120,pins:[16],led_type:'22',strings:[{id:null,label:'Acceptance string',output_offset:0,pixel_count:120}]}]}]};
  await cas('put',cp+'electrical/',electrical);
  const el=await get(cp+'electrical/'); const stringId=el.controllers[0].outputs[0].strings[0].id;
  const lr=await req('get',lp);
  await must(await req('post',cp+'mapping-publish/',{total_pixels:120,spans:[{logical_start:1,length:120,string:stringId,string_offset:0,direction:1}],replacement_allocations:drawerIds.map((id,i)=>({drawer:id,logical_start:i*60+1,logical_end:(i+1)*60}))},{'If-Match':lr.headers().etag}),201,'publish isolated database-only mapping');
  const category=await create('/api/part/category/',{name:`SL image ${run}`,description:'Retained isolated acceptance'});
  const part=await create('/api/part/',{name:`SL image ${run}`,IPN:`SLIMG-${run}`,description:'Retained isolated acceptance',category:category.pk,active:true});
  const stockResult=await create('/api/stock/',{part:part.pk,location:evidence.fixture.drawers[0].bin.location,quantity:7});
  const stock=Array.isArray(stockResult)?stockResult[0]:stockResult;assert.ok(stock.pk);evidence.fixture.stock=stock.pk;
  } else { cabinet={id:evidence.fixture.cabinet,location:evidence.fixture.root}; cp=api+`cabinets/${cabinet.id}/`;lp=cp+'layout/';drawerIds=evidence.fixture.drawers.map(d=>d.id);[cp,lp,cp+'background/'].forEach(p=>allowedWrites.add(p));for(const id of drawerIds)allowedWrites.add(api+`drawers/${id}/background/`); }
  const preservation=async()=>{
    const stock={pk:evidence.fixture.stock};
    const layout=await get(lp), e=await get(cp+'electrical/'), s=await get(`/api/stock/${stock.pk}/`);
    assert.ok(layout.cabinet.active_mapping);assert.equal(layout.cabinet.total_pixels,120);
    return {mapping:layout.cabinet.active_mapping,mapping_hash:layout.cabinet.mapping_hash,allocations:layout.drawers.map(d=>({id:d.id,allocation:d.allocation})),controllers:e.controllers,stock:{id:s.pk,quantity:s.quantity,location:s.location},locations:await Promise.all([cabinet.location,...evidence.fixture.drawers.flatMap(d=>[d.location,d.bin.location])].map(id=>get(`/api/stock/location/${id}/`)))};
  };
  baseline=securityResume?await preservation():resume?evidence.snapshots.preservationBefore:await preservation();assert.equal(Number(baseline.stock.quantity),7);evidence.snapshots.preservationBefore=baseline;pass('populated native stock plus non-null active LED mapping and two allocations baseline');
  const shot=async name=>{assert.ok(!page.url().includes('login'));await page.screenshot({path:`${out}/${name}.png`,fullPage:true});evidence.screenshots.push({path:`${out}/${name}.png`,sha256:hash(fs.readFileSync(`${out}/${name}.png`))});write();};
  const label=name=>page.getByLabel(name,{exact:true});const button=name=>page.getByRole('button',{name,exact:true});
  const open=async(target,id)=>{await page.goto(`${base}/web/plugin/storage-layout/${target}/${id}/design`);await page.getByTestId(target==='cabinets'?'cabinet-designer':'drawer-designer').waitFor({timeout:45000});await expect(button('Upload background').or(button('Replace background'))).toBeEnabled();};
  const raster=async i=>Buffer.from(await page.evaluate(index=>{const c=document.createElement('canvas');c.width=640;c.height=index===0?480:320;const x=c.getContext('2d');x.fillStyle=['#d0d8e0','#b8d8c8','#e8c8a8'][index];x.fillRect(0,0,c.width,c.height);x.strokeStyle='#334455';x.lineWidth=8;for(let k=0;k<3;k++)x.strokeRect(20+k*200,70,180,c.height-100);x.fillStyle='#223344';x.font='28px sans-serif';x.fillText(['CABINET FRONT','DRAWER ONE TOP','DRAWER TWO TOP'][index],24,44);return c.toDataURL('image/png').split(',')[1];},i),'base64');
  const svgrects=()=>page.locator('svg[role=application] rect[style*="move"]');
  const geom=loc=>loc.evaluate(n=>Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(n.getAttribute(k))])));
  const drag=async(loc,dx,dy)=>{await loc.scrollIntoViewIfNeeded();const b=await loc.boundingBox();assert.ok(b);await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:8});await page.mouse.up();};
  const saveBg=async endpoint=>{const p=page.waitForResponse(r=>r.url()===base+endpoint&&r.request().method()==='PATCH');await button('Save background').click();await must(await p,200,'UI metadata save');await expect(page.getByText('Unsaved background changes',{exact:true})).toHaveCount(0);};
  const expected=securityResume?await Promise.all(resume.snapshots.backgrounds.map(async item=>({...item,bg:await get(item.endpoint),sha256:hash(await (await req('get',item.endpoint+'content/')).body())}))):resume?evidence.snapshots.backgrounds:[];
    if(securityResume) evidence.snapshots.backgrounds=expected;
  if (!resume) {
  for(const [i,item] of [{target:'cabinets',id:cabinet.id},...drawerIds.map(id=>({target:'drawers',id}))].entries()){
    const {target,id}=item;const endpoint=api+`${target}/${id}/background/`;await open(target,id);
    const buffer=await raster(i);const pngpath=`${out}/source-${i}.png`;fs.writeFileSync(pngpath,buffer);
    const layoutBefore=await get(target==='cabinets'?lp:api+`drawers/${id}/layout/`);
    const upload=page.waitForResponse(r=>r.url()===base+endpoint&&r.request().method()==='POST');
    await page.locator('input[type=file]').setInputFiles({name:`source-${i}.png`,mimeType:'image/png',buffer});await must(await upload,200,'actual UI multipart image upload');
    await expect(page.getByTestId('background-image')).toBeVisible();
    await label('Edit background image').check();await label('Lock background').uncheck();
    await button('Fit background').click();
    const fitted=await geom(page.getByTestId('background-image'));assert.ok(Math.abs(fitted.width/fitted.height-(i===0?4/3:2))<0.01);
    await label('Background width (canvas fraction)').fill('0.6');await label('Background x (canvas fraction)').fill('0.1');await label('Background y (canvas fraction)').fill('0.1');
    const beforeMove=await geom(page.getByTestId('background-image'));await drag(svgrects().first(),15,10);const moved=await geom(page.getByTestId('background-image'));assert.notDeepEqual(moved,beforeMove);
    const handle=page.locator('svg rect[style*="se-resize"]');await drag(handle,12,8);const resized=await geom(page.getByTestId('background-image'));assert.ok(resized.width>moved.width);assert.ok(Math.abs(resized.width/resized.height-moved.width/moved.height)<0.01);
    await button('Undo background').click();assert.deepEqual(await geom(page.getByTestId('background-image')),moved);
    await button('Redo background').click();assert.deepEqual(await geom(page.getByTestId('background-image')),resized);
    await label('Background opacity').fill(String([0.55,0.65,0.75][i]));
    await label('Show background').uncheck();await expect(page.getByTestId('background-image')).toHaveCount(0);await label('Show background').check();
    await label('Preserve aspect ratio').uncheck();await expect(page.getByTestId('background-image')).toHaveAttribute('preserveAspectRatio','none');await label('Preserve aspect ratio').check();
    await label('Lock background').check();await expect(label('Background width (canvas fraction)')).toBeDisabled();assert.equal(await svgrects().count(),0);
    await saveBg(endpoint);
    const after=await get(target==='cabinets'?lp:api+`drawers/${id}/layout/`);assert.deepEqual(after.drawers??after.drawer,layoutBefore.drawers??layoutBefore.drawer);assert.deepEqual(after.bins,layoutBefore.bins);
    const bg=await get(endpoint);const content=await must(await req('get',endpoint+'content/'),200,'authenticated PNG');assert.match(content.headers()['content-type'],/image\/png/);assert.match(content.headers()['cache-control'],/private/);
    expected.push({...item,endpoint,bg,sha256:hash(await content.body())});
    await label('Edit background image').uncheck();await shot(`desktop-${i}`);
    // Move and resize actual drawer/bin objects on top of saved image, then save.
    const object=svgrects().first();const g0=await geom(object);await drag(object,12,10);const g1=await geom(object);assert.notDeepEqual(g1,g0);
    await drag(page.locator('svg rect[style*="se-resize"]'),10,8);const g2=await geom(object);assert.ok(g2.width>g1.width);
    await button('Undo').click();assert.deepEqual(await geom(object),g1);await button('Redo').click();assert.deepEqual(await geom(object),g2);
    const layoutEndpoint=target==='cabinets'?lp:api+`drawers/${id}/layout/`;const save=page.waitForResponse(r=>r.url()===base+layoutEndpoint&&r.request().method()==='PUT');await button('Save layout').click();await must(await save,200,'UI object layout save');
    await page.reload();await expect(page.getByTestId('background-image')).toBeVisible();assert.deepEqual(await get(endpoint),bg);assert.deepEqual(await geom(svgrects().first()),g2);
    pass(`${target} ${i}: real upload, aspect fit, pointer image/object move+resize, opacity/visibility/lock, undo/redo, separate save and reload`);
  }
  assert.equal(new Set(expected.map(x=>x.sha256)).size,3);evidence.snapshots.backgrounds=expected;
  assert.deepEqual(await preservation(),baseline);pass('stock, all native locations, active mapping, topology and allocations unchanged through image and object edits');
  }
  if (!resume || securityResume) {
  // Backend validation and root-CAS conflict using only fixture endpoints.
  const ep=expected[0].endpoint;let current=await req('get',ep);const etag=current.headers().etag;const bg=await current.json();
  for(const [name,mimeType,buffer] of [['bad.svg','image/svg+xml',Buffer.from('<svg/>')],['broken.png','image/png',Buffer.from('invalid PNG')],['too-large.png','image/png',Buffer.alloc(8*1024*1024+1)]]){
    await must(await req('post',ep,undefined,{'If-Match':etag},{image:{name,mimeType,buffer}}),400,`invalid upload ${name}`);
  }
  await must(await req('patch',ep,{...bg.metadata,opacity:2},{'If-Match':etag}),400,'invalid transform');
  await must(await req('patch',ep,bg.metadata),428,'missing CAS');
  await must(await req('patch',ep,bg.metadata,{'If-Match':'"1"'}),412,'stale CAS');
  assert.deepEqual(await get(ep),bg);assert.equal((await req('get',ep)).headers().etag,etag);pass('invalid SVG/corrupt/oversize and transforms rejected atomically; missing 428 / stale 412');
  await open('cabinets',cabinet.id);await label('Edit background image').check();await label('Background opacity').fill('0.42');
  const external=await req('get',ep);await must(await req('patch',ep,bg.metadata,{'If-Match':external.headers().etag}),200,'concurrent operator metadata save');
  const stale=page.waitForResponse(r=>r.url()===base+ep&&r.request().method()==='PATCH');await button('Save background').click();await must(await stale,412,'actual browser stale conflict');await expect(label('Background opacity')).toHaveValue('0.42');await shot('stale-conflict');await button('Revert background').click();
  pass('browser conflict retains unsaved metadata rather than silently overwriting');
  // Real SPA route through existing host navigation, dismissed then accepted.
  await label('Background opacity').fill('0.43');let dialogs=0;const dismiss=d=>{dialogs++;return d.dismiss();};page.on('dialog',dismiss);
  const original=page.url();await page.getByRole('tab',{name:'Storage Layout',exact:true}).click();assert.equal(page.url(),original);assert.equal(dialogs,1);page.off('dialog',dismiss);
  await button('Revert background').click();await label('Edit background image').uncheck();
  await page.getByRole('tab',{name:'Storage Layout',exact:true}).click();await page.getByTestId('cabinet-list').waitFor();
  pass('actual host SPA navigation cancels dirty background; clean navigation succeeds');
  }
  const ep=expected[0].endpoint;
  if (!securityResume) {
  // Narrow viewport uses the actual deployed host, not a fixture harness.
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+`/web/plugin/storage-layout/cabinets/${cabinet.id}/design`);await page.getByText('Mobile viewport detected',{exact:true}).waitFor();await shot('mobile-gate-390');
  evidence.gaps.push('Default host blocks width <425 px before plugin mounts. 390 px plugin tests use the existing browser-local allowMobile preference, not server configuration.');
  await page.setViewportSize({width:425,height:844});
  for(const [i,item] of expected.entries()){
    await open(item.target,item.id);await expect(page.getByTestId('background-image')).toBeVisible();await label('Edit background image').check();
    await label('Background opacity').fill(String([0.55,0.65,0.75][i])); // no state change
    await label('Background opacity').fill('0.35');await button('Undo background').click();await expect(label('Background opacity')).toHaveValue(String([0.55,0.65,0.75][i]));await button('Redo background').click();await saveBg(item.endpoint);await label('Background opacity').fill(String([0.55,0.65,0.75][i]));await saveBg(item.endpoint);
    const replace=page.waitForResponse(r=>r.url()===base+item.endpoint&&r.request().method()==='POST');await page.locator('input[type=file]').setInputFiles(`${out}/source-${i}.png`);await must(await replace,200,'narrow real file replacement');await expect(page.getByTestId('background-image')).toBeVisible();
    await button('Save background').scrollIntoViewIfNeeded();await shot(`narrow-${i}`);
    evidence.snapshots[`narrow-${i}`]=await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('button')].filter(b=>['Save background','Fit background'].includes(b.textContent)).map(b=>({text:b.textContent,rect:b.getBoundingClientRect().toJSON()}))}));
    await label('Edit background image').uncheck();
  }
  pass('425x844 default authenticated narrow cabinet and both drawer images rendered; controls scrolled into view');
  await page.evaluate(()=>{const stored=JSON.parse(localStorage.getItem('session-settings'));stored.state.allowMobile=true;localStorage.setItem('session-settings',JSON.stringify(stored));});
  await page.setViewportSize({width:390,height:844});
  for(const [i,item] of expected.entries()){await open(item.target,item.id);await expect(page.getByTestId('background-image')).toBeVisible();await label('Edit background image').check();await label('Background opacity').fill(String([0.55,0.65,0.75][i]));await button('Save background').scrollIntoViewIfNeeded();await shot(`override-390-${i}`);await label('Edit background image').uncheck();}
  pass('390x844 real host with explicit browser-local allowMobile override renders all three backgrounds');
  }
  const userName=`sl_image_${run.replaceAll('-','').slice(0,20)}`;const userPassword=crypto.randomBytes(28).toString('base64url')+'9a!';
  secrets.push(userPassword);
  const user=evidence.fixture.restrictedUser?await get(`/api/user/${evidence.fixture.restrictedUser}/`):await create('/api/user/',{username:userName,email:userName+'@invalid.example',first_name:'Isolated',last_name:'Acceptance',is_active:true,is_staff:false,is_superuser:false});
  const userPath=`/api/user/${user.pk}/set-password/`;allowedWrites.add(userPath);await must(await req('patch',userPath,{password:userPassword}),200,'set isolated user password');evidence.fixture.restrictedUser=user.pk;
  const restricted=await browser.newContext();const rp=await restricted.newPage();await login(restricted,rp,user.username,userPassword);
  const uc=(await restricted.cookies()).find(c=>c.name==='csrftoken')?.value;
  for(const item of expected){
    for(const method of ['get','patch','post']){
      const r=await restricted.request[method](base+item.endpoint,{headers:{'X-CSRFToken':uc,Referer:base+'/web/','If-Match':(await req('get',ep)).headers().etag},...(method==='patch'?{data:item.bg.metadata}:method==='post'?{multipart:{image:{name:'probe.png',mimeType:'image/png',buffer:securityResume?await (await req('get',ep+'content/')).body():fs.readFileSync(`${out}/source-0.png`)}}}:{})});
      evidence.http.push({actor:'restricted',method,path:item.endpoint,status:r.status()});assert.equal(r.status(),403);
    }
    const r=await restricted.request.get(base+item.endpoint+'content/');evidence.http.push({actor:'restricted',method:'get',path:item.endpoint+'content/',status:r.status()});assert.equal(r.status(),403);
  }
  await restricted.close();pass('genuine non-admin browser session: cabinet and both drawer metadata/upload/content denied 403');
  const anonymous=await browser.newContext();const anon=await anonymous.request.get(base+ep+'content/');assert.ok([401,403].includes(anon.status()));await anonymous.close();pass('anonymous private image content denied');
  // Let the authenticated API throttle window clear after the permission matrix.
  if(securityResume) await new Promise(resolve=>setTimeout(resolve,3000));
  const ownerSetting=await get('/api/settings/global/STOCK_OWNERSHIP_CONTROL/');evidence.snapshots.ownershipControl={key:ownerSetting.key,value:ownerSetting.value};
  evidence.gaps.push('Cross-owner with view/change permissions requires ownership-control setting and suitable isolated owner configuration; not inferred from 403 no-permission tests.');
  if(securityResume) {
    for(const item of expected) { assert.deepEqual(await get(item.endpoint),item.bg); assert.equal(hash(await (await req('get',item.endpoint+'content/')).body()),item.sha256); }
    assert.deepEqual(await preservation(),baseline);
    evidence.snapshots.preservationAfter=await preservation();
    evidence.blockedRequests=blocked;
    assert.ok(blocked.every(p=>p==='/api/system-internal/observability/end'));
    evidence.gaps.push('Cross-owner live test unavailable with shared ownership control disabled; no setting changed. No restart in this targeted run.');
    pass('current-runtime security probes preserve all saved background bytes/metadata, populated stock, locations, active mapping, topology and allocations');
    evidence.result='PASS_WITH_DOCUMENTED_LIMITATIONS';write();console.log(`EVIDENCE ${out}/report.json`);return;
  }
  const savedLayouts=await get(lp);evidence.snapshots.layoutBeforeRestart=savedLayouts;
  await page.setViewportSize({width:1600,height:1100});
  execFileSync('ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','IdentitiesOnly=yes','-i','/home/spetchal/.ssh/myinventree-development-deploy_ed25519','inventree-deploy@mainserver-1','inventree-deploy restart'],{encoding:'utf8',timeout:180000,stdio:['ignore','pipe','pipe']});
  let healthy=false;for(let i=0;i<60;i++){try{if((await context.request.get(base+'/api/',{timeout:5000})).ok()){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,2000));}assert.ok(healthy);
  for(const [i,item] of expected.entries()){
    await open(item.target,item.id);await expect(page.getByTestId('background-image')).toBeVisible();assert.deepEqual(await get(item.endpoint),item.bg);assert.equal(hash(await (await req('get',item.endpoint+'content/')).body()),item.sha256);await shot(`restart-${i}`);
  }
  assert.deepEqual(await get(lp),savedLayouts);assert.deepEqual(await preservation(),baseline);
  evidence.snapshots.preservationAfterRestart=await preservation();pass('restricted Development restart: all three PNG hashes, transforms, layout, populated stock/native locations/mapping/allocations preserved');
  evidence.blockedRequests=blocked;assert.deepEqual(blocked,[]);pass('no browser hardware/controller/external-origin requests attempted');
  evidence.gaps.push('Deployed drawer panes overflow at 425px (scrollWidth 852px); focused source fix and local 390/425 regression are not deployed.');
  evidence.checks=[...new Set(evidence.checks)];evidence.gaps=[...new Set(evidence.gaps)];evidence.screenshots=[...new Map(evidence.screenshots.map(s=>[s.path,s])).values()];
  evidence.result='PARTIAL_ACCEPTANCE';evidence.previousFailures=[...(evidence.previousFailures??[]),...(evidence.failure?[evidence.failure]:[])];delete evidence.failure;write();console.log(`EVIDENCE ${out}/report.json`);
})().catch(error=>{evidence.result='FAIL';evidence.failure=redact(error.message).slice(0,2500);write();console.error(evidence.failure);process.exitCode=1;}).finally(async()=>{await browser?.close();});
