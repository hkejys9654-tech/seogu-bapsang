// Fault injection against the actual application functions. This is an isolated
// transaction model, not a production Firebase capacity or network measurement.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(process.env.BAPSANG_HTML||path.join(__dirname,'../index.html'),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const day='2026-10-20',rid=`${day}_1234`,slot=`${day}_1200`;
const clone=v=>v===undefined?undefined:structuredClone(v);
function merge(a,b){const out={...a};for(const [k,v] of Object.entries(b)){if(v==='DELETE_FIELD')delete out[k];else if(v&&typeof v==='object'&&!Array.isArray(v))out[k]=merge(out[k]||{},v);else out[k]=v;}return out;}
function error(code){return Object.assign(new Error(`Injected ${code}`),{code});}
function setup({faults=[],seed=false,group=3,confirmation='',onServerGet,fastTimeout=false}={}){
 const docs=new Map(),stats={commits:0,attempts:0,toasts:[],routes:[],refreshes:[],reads:[],serverReads:[],queues:[],timeoutDelays:[]};
 const plan=[...faults];
 const snap=ref=>({id:ref.id,exists:docs.has(ref.path),data:()=>clone(docs.get(ref.path)),metadata:{fromCache:false,hasPendingWrites:false}});
 const db={collection:name=>({doc:id=>{const ref={path:`${name}/${id}`,id};ref.get=async options=>{
  stats.serverReads.push({path:ref.path,options:clone(options)});
  if(onServerGet)return onServerGet(ref,snap(ref),c);
  if(confirmation==='reject')throw error('unavailable');
  if(confirmation==='hang')return new Promise(()=>{});
  const result=snap(ref);
  if(confirmation==='cache')result.metadata.fromCache=true;
  if(confirmation==='pending')result.metadata.hasPendingWrites=true;
  return result;
 };return ref;}}),runTransaction:async fn=>{
  stats.attempts++;const fault=plan.shift();if(fault?.stage==='before')throw error(fault.code);
  const pending=[];
  const result=await fn({get:async ref=>{assert.equal(pending.length,0,'all reads precede writes');stats.reads.push(ref.path);if(fault?.stage==='read')throw error(fault.code);return snap(ref);},set:(ref,value,options)=>pending.push({ref,value:clone(value),merge:!!options?.merge}),update:(ref,value)=>pending.push({ref,value:clone(value),merge:true})});
  if(fault?.stage==='commit')throw error(fault.code);
  for(const w of pending)docs.set(w.ref.path,w.merge?merge(docs.get(w.ref.path)||{},w.value):w.value);
  if(pending.length)stats.commits++;
  if(fault?.stage==='after')throw error(fault.code);
  return result;
 }};
 const c={Date,Intl,Promise,Map,Set,Uint8Array,TextEncoder,structuredClone,console:{error(){},warn(){}},setTimeout:(fn,ms)=>{stats.timeoutDelays.push(ms);return setTimeout(fn,fastTimeout?5:ms);},clearTimeout,document:{addEventListener(){},getElementById:()=>null},localStorage:{getItem:()=>null},navigator:{onLine:true},__db:db,__stats:stats,__group:group,firebase:{firestore:{FieldValue:{serverTimestamp:()=>123,delete:()=> 'DELETE_FIELD'}}}};
 vm.createContext(c);vm.runInContext(source,c);
 const run=s=>vm.runInContext(s,c);
 run(`firebaseOn=true;db=__db;st.date='${day}';st.slot='12:00';st.adminCallSlot='12:00';st.user={emp:'1234',name:'테스트',orgKey:'planning',dept:'기획실'};st.reservations=[];st.queueControls={};todayDate=()=> '${day}';reservationWindowOpen=()=>true;reservationTimePassed=()=>false;selectedPartySize=()=>__group;canBookTime=()=>true;render=()=>{};go=tab=>__stats.routes.push(tab);toast=message=>__stats.toasts.push(message);refreshOverview=async force=>{__stats.refreshes.push(force)};listenOwnQueue=r=>__stats.queues.push(r.id);saveLocal=()=>{};`);
 if(seed){
  const row={id:rid,name:'테스트',emp:'1234',orgKey:'planning',dept:'기획실',date:day,time:'12:00',status:'reserved',partySize:group,queueNumber:1,qrEligible:true,callStatus:'waiting',code:`SGMEAL|${day}|12:00|1234`,requeueCount:0};
  docs.set(`reservations/${rid}`,row);docs.set(`slotCounts/${slot}`,{date:day,time:'12:00',cap:50,count:group,nextQueueNumber:1,queueLedgerVersion:1,queueEntries:{1:{size:group,waiting:true}}});
  run(`st.reservations=${JSON.stringify([row])};st.queueControls['${slot}']={date:'${day}',time:'12:00',closed:false,callRevision:0};`);
 }
 return{c,run,docs,stats,plan};
}
for(const code of ['unavailable','aborted','resource-exhausted','permission-denied','deadline-exceeded']){
 test(`booking ${code} before commit leaves no partial reservation and unlocks retry`,async()=>{
  const h=setup({faults:[{stage:'commit',code}]});await h.c.reserve();
  assert.equal(h.docs.size,0);assert.equal(h.stats.commits,0);
  assert.equal(h.run('Boolean(reserve.pending||reserveFirebase.pending)'),false);
  assert.equal(h.stats.routes.includes('my'),false);
  const expected={unavailable:'서버에 연결하지 못했어요.',aborted:'동시 예약이 몰려',
   'resource-exhausted':'서버 이용 한도','permission-denied':'예약 권한','deadline-exceeded':'서버 응답이 늦어졌어요.'};
  assert.ok(h.stats.toasts.at(-1).includes(expected[code]));
  const needsConfirmation=['unavailable','deadline-exceeded'].includes(code);
  assert.equal(h.stats.serverReads.length,needsConfirmation?1:0);
  if(needsConfirmation){assert.equal(h.stats.serverReads[0].options.source,'server');assert.ok(h.stats.toasts.at(-1).includes('저장된 예약이 없으니 다시 예약'));}
  await h.c.reserve();assert.equal(h.docs.get(`slotCounts/${slot}`).count,3);assert.equal(h.stats.commits,1);
 });
}
test('offline transaction rejection does not create a local success or consume capacity',async()=>{
 const h=setup({faults:[{stage:'before',code:'unavailable'}],confirmation:'reject'});h.c.navigator.onLine=false;await h.c.reserve();
 assert.equal(h.docs.size,0);assert.equal(h.run('st.reservations.length'),0);assert.equal(h.stats.routes.includes('my'),false);assert.equal(h.run('Boolean(reserve.pending||reserveFirebase.pending)'),false);
 assert.ok(h.stats.toasts.at(-1).includes('인터넷 연결이 끊겼어요.'));assert.ok(h.stats.toasts.at(-1).includes('예약 여부를 확인하지 못했어요'));
});
test('lost booking acknowledgment and retry create exactly one group and queue entry',async()=>{
 const h=setup({faults:[{stage:'after',code:'unavailable'}],group:10});await h.c.reserve();
 assert.equal(h.stats.routes.at(-1),'my');assert.equal(h.stats.toasts.at(-1),'예약이 확인되었습니다. 입장표를 확인해주세요.');
 assert.equal(h.run('st.reservations[0].partySize'),10);assert.equal(h.run(`confirmedReservations.get('${rid}').partySize`),10);
 assert.equal(h.run('dataState.reservation'),'ready');assert.equal(h.run('reservationSnapshotReady'),true);assert.deepEqual(h.stats.queues,[rid]);
 assert.deepEqual(h.stats.serverReads,[{path:`reservations/${rid}`,options:{source:'server'}}]);
 await h.c.reserve();assert.equal(h.stats.toasts.at(-1),'이미 오늘 예약이 있습니다.');assert.equal(h.stats.serverReads.length,1);
 assert.equal(h.stats.commits,1);assert.equal(h.docs.get(`reservations/${rid}`).partySize,10);assert.equal(h.docs.get(`slotCounts/${slot}`).count,10);assert.equal(h.docs.get(`slotCounts/${slot}`).nextQueueNumber,1);assert.equal(Object.keys(h.docs.get(`slotCounts/${slot}`).queueEntries).length,1);
});
test('an existing reservation opens its server-confirmed ticket without another read',async()=>{
 const h=setup({seed:true});h.run('st.reservations=[]');await h.c.reserve();
 assert.equal(h.stats.commits,0);assert.equal(h.stats.serverReads.length,0);assert.equal(h.stats.routes.at(-1),'my');
 assert.equal(h.run('st.reservations[0].id'),rid);assert.equal(h.run(`confirmedReservations.has('${rid}')`),true);
});
test('denied or aborted requests never perform an uncertain-result read even when offline',async()=>{
 for(const code of ['permission-denied','unauthenticated','aborted','resource-exhausted']){
  const h=setup({faults:[{stage:'before',code}]});h.c.navigator.onLine=false;await h.c.reserve();
  assert.equal(h.stats.serverReads.length,0,code);assert.equal(h.stats.routes.length,0);assert.equal(h.stats.commits,0);
 }
});
test('cached, pending, or unavailable confirmation never claims booking success or absence',async()=>{
 for(const confirmation of ['cache','pending','reject']){
  const h=setup({faults:[{stage:'after',code:'firestore/unavailable'}],confirmation});await h.c.reserve();
  assert.equal(h.stats.commits,1);assert.equal(h.stats.routes.length,0);assert.equal(h.run('confirmedReservations.size'),0);
  assert.equal(h.stats.serverReads.length,1);assert.ok(h.stats.toasts.at(-1).includes('예약 여부를 확인하지 못했어요'));
  assert.equal(h.stats.toasts.at(-1).includes('저장된 예약이 없으니'),false);
 }
});
test('reservation confirmation stops waiting after five seconds and ignores a late response',async()=>{
 let resolveRead;
 const h=setup({faults:[{stage:'after',code:'deadline-exceeded'}],fastTimeout:true,onServerGet:(_ref,snap)=>new Promise(resolve=>{resolveRead=()=>resolve(snap);})});
 await h.c.reserve();assert.deepEqual(h.stats.timeoutDelays,[5000]);assert.equal(h.run('Boolean(reserve.pending||reserveFirebase.pending)'),false);
 assert.equal(h.stats.routes.length,0);assert.ok(h.stats.toasts.at(-1).includes('예약 여부를 확인하지 못했어요'));
 resolveRead();await new Promise(resolve=>setImmediate(resolve));assert.equal(h.stats.routes.length,0);assert.equal(h.run('st.reservations.length'),0);
});
test('a server-confirmed canceled reservation is safe to retry',async()=>{
 const h=setup({seed:true,faults:[{stage:'before',code:'unavailable'}]});h.docs.get(`reservations/${rid}`).status='cancelled';
 await h.c.reserve();assert.equal(h.stats.routes.length,0);assert.ok(h.stats.toasts.at(-1).includes('저장된 예약이 없으니 다시 예약'));
});
test('recovery cannot show another employee, date, or replaced connection scope',async()=>{
 for(const change of ["st.user={...st.user,emp:'5678'}", "st.date='2026-10-21';todayDate=()=> '2026-10-21'",'dataEpoch++']){
  const h=setup({faults:[{stage:'after',code:'unavailable'}],onServerGet:(_ref,snap,c)=>{vm.runInContext(change,c);return snap;}});
  await h.c.reserve();assert.equal(h.stats.routes.length,0,change);assert.equal(h.stats.toasts.length,0,change);
  assert.equal(h.run('st.reservations.length'),0);assert.equal(h.run('confirmedReservations.size'),0);assert.equal(h.run('Boolean(reserve.pending||reserveFirebase.pending)'),false);
 }
});
test('full, shared-full, and closed slots force an immediate overview refresh',async()=>{
 const full=setup();full.docs.set(`slotCounts/${slot}`,{count:49});await full.c.reserve();assert.deepEqual(full.stats.refreshes,[true]);
 const closed=setup();closed.docs.set(`queueControls/${slot}`,{closed:true});await closed.c.reserve();assert.deepEqual(closed.stats.refreshes,[true]);
 const shared=setup();shared.run('isOverflowChoice=()=>true;overflowQuotaReleased=()=>false');shared.docs.set(`slotCounts/${slot}`,{count:0,overflowCount:999});
 await shared.c.reserve();assert.deepEqual(shared.stats.refreshes,[true]);assert.ok(shared.stats.toasts.at(-1).includes('공유 좌석'));
});
test('lost cancellation acknowledgment and retry release group capacity only once',async()=>{
 const h=setup({seed:true,faults:[{stage:'after',code:'unavailable'}],group:10});await h.c.cancelFirebase(rid);await h.c.cancelFirebase(rid);
 assert.equal(h.stats.commits,1);assert.equal(h.docs.get(`slotCounts/${slot}`).count,0);assert.equal(h.docs.get(`reservations/${rid}`).status,'cancelled');
});
test('lost check-in acknowledgment and retry never consume capacity twice',async()=>{
 const h=setup({seed:true,faults:[{stage:'after',code:'unavailable'}]});await h.c.checkin(rid);await h.c.checkin(rid);
 assert.equal(h.stats.commits,1);assert.equal(h.docs.get(`slotCounts/${slot}`).count,3);assert.equal(h.docs.get(`reservations/${rid}`).status,'checkedin');
});
test('failed call transaction rolls back every member and clears shared operation lock',async()=>{
 const h=setup({seed:true,faults:[{stage:'commit',code:'permission-denied'}]});const before=clone([...h.docs]);await h.c.callNext(10);
 assert.deepEqual([...h.docs],before);assert.equal(h.run('Boolean(callNext.pending)'),false);assert.equal(h.stats.commits,0);
 await h.c.callNext(10);assert.equal(h.stats.commits,1);assert.equal(h.docs.get(`reservations/${rid}`).callStatus,'called');assert.equal(h.docs.get(`slotCounts/${slot}`).count,3);
});
test('lost call acknowledgment cannot advance the same stale admin selection twice',async()=>{
 const h=setup({seed:true,faults:[{stage:'after',code:'unavailable'}]});await h.c.callNext(10);await h.c.callNext(10);
 assert.equal(h.stats.commits,1);assert.equal(h.docs.get(`queueControls/${slot}`).callRevision,1);assert.equal(h.docs.get(`reservations/${rid}`).callStatus,'called');
});
test('booking closure detected on the final transaction read produces no writes',async()=>{
 const h=setup();let open=true;h.c.reservationWindowOpen=()=>open;const base=h.c.__db.runTransaction;
 h.c.__db.runTransaction=fn=>base(tx=>fn({...tx,get:async ref=>{const result=await tx.get(ref);if(ref.path===`slotCounts/${slot}`)open=false;return result;}}));
 await h.c.reserve();assert.equal(h.docs.size,0);assert.equal(h.stats.commits,0);
});
