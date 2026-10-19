const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(process.env.BAPSANG_HTML||path.join(__dirname,'../index.html'),'utf8');
function functionSource(name){const re=/^(?:async )?function [A-Za-z_$][\w$]*\(/gm;const starts=[...html.matchAll(re)];const i=starts.findIndex(m=>m[0].includes(`function ${name}(`));assert.ok(i>=0,`${name} exists`);return html.slice(starts[i].index,starts[i+1]?.index||html.length);}
const source=['queueLedgerPatch','reserve','reserveFirebase','cancelFirebase','requestRequeue','requestRequeueFirebase','markNoShow','markNoShowFirebase','checkinValidationMessage','completeReservationCheckin'].map(functionSource).join('\n');
const day='2026-10-16',rid=`${day}_1234`,slot=(time='11:40')=>`slotCounts/${day}_${time.replace(':','')}`;
const clone=v=>JSON.parse(JSON.stringify(v));
function row(extra={}){return {id:rid,date:day,time:'11:40',originalTime:'11:40',assignedTime:'11:40',emp:'1234',name:'테스트',dept:'기획실',status:'reserved',qrEligible:true,partySize:3,queueNumber:1,callStatus:'waiting',code:`SGMEAL|${day}|11:40|1234`,...extra};}
function summary(extra={}){return {date:day,time:'11:40',cap:50,count:3,overflowCount:0,nextQueueNumber:1,queueLedgerVersion:1,queueEntries:{1:{size:3,waiting:true}},...extra};}
function merge(a,b){const out={...a};for(const [k,v] of Object.entries(b)){if(v==='DELETE_FIELD')delete out[k];else if(v&&typeof v==='object'&&!Array.isArray(v))out[k]=merge(out[k]||{},v);else out[k]=v;}return out;}
function setup(options={}){
 const docs=new Map(Object.entries(options.docs||{}).map(([k,v])=>[k,clone(v)])),stats={transactions:0,writes:[],reads:[],toasts:[]};
 let chain=Promise.resolve();
 const c={console:{error(){}},st:{user:{emp:'1234',name:'테스트',dept:'기획실'},slot:'11:40',date:day,reservations:options.localRows||[],penalties:{}},firebaseOn:options.cloud!==false,
  todayDate:()=>day,selectedPartySize:()=>c.partySize||3,userOrganization:()=>({key:'plan',name:'기획실'}),assignedSlot:()=> '11:40',isEligibleTime:()=>true,isOverflowChoice:()=>false,
  canBookTime:()=>true,remain:()=>50,isQueueClosed:()=>!!options.locallyClosed,isBlocked:()=>false,blockMessage:()=>'',myOnDate:d=>c.st.reservations.find(r=>r.date===d&&r.emp===c.st.user.emp&&r.status!=='cancelled'),
  reservationWindowOpen:()=>options.windowOpen!==false,reservationWindowMessage:()=>"10:00–11:00 예약 접수",reservationTimePassed:()=>!!options.expired,LATE_ARRIVAL_NOTICE:"12:00 이후 이용",reservationDeadlinePassed:()=>!!options.late,lateReservationNotice:()=> 'late',overflowQuotaReleased:()=>true,EARLY_OVERFLOW_QUOTA:10,
  SLOTS:[['11:40',50],['11:55',50]],slotIndex:time=>['11:40','11:55'].indexOf(time),requeueTarget:r=>options.target||r.time,
  docId:(date,emp)=>`${date}_${emp}`,slotId:(date,time)=>`${date}_${time.replace(':','')}`,queueControlKey:(date,time)=>`${date}_${time.replace(':','')}`,code:(date,time,emp)=>`SGMEAL|${date}|${time}|${emp}`,
  partySizeOf:r=>Math.max(1,Math.min(10,Math.trunc(Number(r&&r.partySize)||1))),isLateReservationStatus:s=>s==='late'||s==='late_reserved',nextDate:()=> '2026-10-17',
  refreshOverview:async()=>{},saveLocal(){},render(){},go(){},updateLoginState(){},toast:message=>stats.toasts.push(message),
  firebase:{firestore:{FieldValue:{serverTimestamp:()=> 'NOW',delete:()=> 'DELETE_FIELD'}}},
  db:{collection:name=>({doc:id=>`${name}/${id}`}),runTransaction:callback=>{stats.transactions++;const result=chain.then(async()=>{const pending=[];
   const value=await callback({get:async ref=>{assert.equal(pending.length,0,'transaction reads precede every write');stats.reads.push(ref);if(options.onGet)await options.onGet(ref,c,docs);return {exists:docs.has(ref),data:()=>clone(docs.get(ref))};},
    update:(ref,data)=>pending.push({ref,data:clone(data),merge:true}),set:(ref,data,opts)=>pending.push({ref,data:clone(data),merge:!!opts?.merge})});
   for(const w of pending){docs.set(w.ref,w.merge?merge(docs.get(w.ref)||{},w.data):w.data);stats.writes.push(w);}return value;});chain=result.catch(()=>{});return result;}}
 };vm.createContext(c);vm.runInContext(source,c);return {c,docs,stats};
}
function seeded(extra={},slotExtra={}){return {[`reservations/${rid}`]:row(extra),[slot()]:summary(slotExtra)};}

test('queue ledger marks only new empty or already-complete summaries complete',()=>{
 const h=setup(),r=row();assert.equal(h.c.queueLedgerPatch({},null,r).queueLedgerVersion,1);
 assert.equal(h.c.queueLedgerPatch({count:3,nextQueueNumber:1},null,r).queueLedgerVersion,undefined);
 assert.equal(h.c.queueLedgerPatch({count:0,nextQueueNumber:9},null,r).queueLedgerVersion,undefined);
 assert.equal(h.c.queueLedgerPatch(summary(),r,{...r,status:'cancelled'}).queueLedgerVersion,1);
});
test('queue ledger stores only anonymous size and waiting state and emits merge-safe tombstones',()=>{
 const h=setup();const p=h.c.queueLedgerPatch(summary(),row(),row({status:'checkedin'}));
 assert.deepEqual(clone(p.queueEntries),{'1':{size:0,waiting:false}});
 const moved=h.c.queueLedgerPatch(summary(),row(),row({queueNumber:2}));
 assert.deepEqual(clone(moved.queueEntries),{'1':{size:0,waiting:false},'2':{size:3,waiting:true}});
 assert.equal(JSON.stringify(moved).includes('1234'),false);
});
test('booking captures employee, slot and group size before asynchronous work',async()=>{
 let changed=false;const h=setup({onGet:async(ref,c)=>{if(!changed){changed=true;c.st.slot='11:55';c.st.user={emp:'5678',name:'변경',dept:'다른부서'};c.partySize=9;}}});
 await h.c.reserve();const booked=h.docs.get(`reservations/${rid}`);
 assert.equal(booked.time,'11:40');assert.equal(booked.emp,'1234');assert.equal(booked.partySize,3);
 assert.equal(h.docs.get(slot()).count,3);assert.equal(h.docs.get(slot()).time,'11:40');assert.equal(h.docs.has(slot('11:55')),false);
 assert.equal(h.docs.get(slot()).queueLedgerVersion,1);assert.deepEqual(h.docs.get(slot()).queueEntries,{'1':{size:3,waiting:true}});
});
test('closed slot rejects booking inside the transaction even if the cached screen is open',async()=>{
 const h=setup({docs:{[`queueControls/${day}_1140`]:{closed:true}}});await h.c.reserve();
 assert.equal(h.stats.writes.length,0);assert.ok(h.stats.toasts.some(t=>t.includes('마감')));
});
test('a second booking click while pending cannot start another transaction',async()=>{
 let release;const gate=new Promise(resolve=>release=resolve);const h=setup({onGet:()=>gate});
 const first=h.c.reserve();await new Promise(resolve=>setImmediate(resolve));await h.c.reserve();
 assert.equal(h.stats.transactions,1);release();await first;assert.equal(h.c.reserve.pending,false);
});
test('existing active representative booking and a full group slot cannot reserve again',async()=>{
 for(const docs of [seeded(),{[slot()]:summary({count:49})}]){const h=setup({docs});await h.c.reserve();assert.equal(h.stats.writes.length,0);}
});
test('canceling a group releases its exact size once and removes its waiting entry',async()=>{
 const h=setup({docs:seeded()});await h.c.cancelFirebase(rid);await h.c.cancelFirebase(rid);
 assert.equal(h.docs.get(slot()).count,0);assert.deepEqual(h.docs.get(slot()).queueEntries['1'],{size:0,waiting:false});
 assert.equal(h.stats.writes.filter(w=>w.ref===slot()).length,1);
});
test('repeated no-show or no-show after cancellation cannot debit a group twice',async()=>{
 const h=setup({docs:seeded({}, {count:10})});await h.c.markNoShowFirebase(rid);await h.c.markNoShowFirebase(rid);
 assert.equal(h.docs.get(slot()).count,7);assert.equal(h.stats.writes.filter(w=>w.ref===slot()).length,1);
 const canceled=setup({docs:seeded({status:'cancelled'})});await canceled.c.markNoShowFirebase(rid);assert.equal(canceled.stats.writes.length,0);
});
test('check-in clears the waiting entry but preserves already-booked group capacity',async()=>{
 const h=setup({docs:seeded()});const result=await h.c.completeReservationCheckin(rid);
 assert.ok(result.reservation);assert.equal(h.docs.get(`reservations/${rid}`).status,'checkedin');assert.equal(h.docs.get(slot()).count,3);
 assert.deepEqual(h.docs.get(slot()).queueEntries['1'],{size:0,waiting:false});
 assert.ok((await h.c.completeReservationCheckin(rid)).error);assert.equal(h.stats.writes.filter(w=>w.ref===slot()).length,1);
});
test('same-slot requeue atomically tombstones the old number and appends the full group',async()=>{
 const h=setup({docs:seeded({callStatus:'passed'},{queueEntries:{1:{size:3,waiting:false}}})});
 await h.c.requestRequeueFirebase(rid,'11:40');const s=h.docs.get(slot());assert.equal(s.count,3);assert.equal(s.nextQueueNumber,2);
 assert.deepEqual(s.queueEntries['1'],{size:0,waiting:false});assert.deepEqual(s.queueEntries['2'],{size:3,waiting:true});
 await h.c.requestRequeueFirebase(rid,'11:40');assert.equal(h.docs.get(slot()).nextQueueNumber,2);
});
test('cross-slot requeue cannot take a seat from a later reserved session',async()=>{
 const h=setup({docs:seeded({callStatus:'passed'})});
 await h.c.requestRequeueFirebase(rid,'11:55');
 assert.equal(h.stats.writes.length,0);assert.equal(h.docs.get(slot()).count,3);
 assert.ok(h.stats.toasts.some(t=>t.includes('12:00')));
});
test('requeue rejects canceled, completed and past-day reservations before ledger changes',async()=>{
 for(const extra of [{status:'cancelled'},{status:'checkedin'},{date:'2026-10-15'}]){const h=setup({docs:seeded({callStatus:'passed',...extra})});await h.c.requestRequeueFirebase(rid,'11:55');assert.equal(h.stats.writes.length,0);}
});
test('legacy nonempty summary remains incomplete after normal booking',async()=>{
 const h=setup({docs:{[slot()]:{date:day,time:'11:40',count:5,nextQueueNumber:3}}});await h.c.reserve();
 const s=h.docs.get(slot());assert.equal(s.queueLedgerVersion,undefined);assert.equal(s.count,8);
});
test('local canceled rebooking replaces its stable ID instead of creating duplicate rows',async()=>{
 const h=setup({cloud:false,localRows:[row({status:'cancelled'})]});await h.c.reserve();assert.equal(h.c.st.reservations.length,1);assert.equal(h.c.st.reservations[0].status,'reserved');
});

test('outside the reservation window local and cloud entry points make no writes',async()=>{
 for(const cloud of [true,false]){
  const h=setup({cloud,windowOpen:false});await h.c.reserve();await h.c.reserveFirebase();
  assert.equal(h.stats.transactions,0);assert.equal(h.stats.writes.length,0);assert.equal(h.c.st.reservations.length,0);
 }
});
test('11:00 arriving during the transaction rolls back booking and slot counts',async()=>{
 const h=setup({onGet:async(ref,c)=>{if(ref===slot())c.reservationWindowOpen=()=>false;}});
 await h.c.reserve();assert.equal(h.stats.writes.length,0);assert.equal(h.docs.size,0);
});
test('expired reservation cannot rejoin even its original session',async()=>{
 const h=setup({expired:true,docs:seeded({callStatus:'passed'})});await h.c.requestRequeueFirebase(rid,'11:40');
 assert.equal(h.stats.writes.length,0);assert.ok(h.stats.toasts.some(t=>t.includes('12:00')));
});
test('slot expiry during requeue also prevents committing the retry',async()=>{
 const h=setup({docs:seeded({callStatus:'passed'}),onGet:async(ref,c)=>{if(ref===slot())c.reservationTimePassed=()=>true;}});
 await h.c.requestRequeueFirebase(rid,'11:40');assert.equal(h.stats.writes.length,0);
});
