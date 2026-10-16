const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(process.env.CALL_FLOW_HTML||path.join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('async function callNext(size){'),html.indexOf('async function addNotice(){'));
const date='2026-10-17',time='11:40',slot=`${date}_1140`;
function setup(options={}){
  const rows=[{id:'a',queueNumber:1,partySize:2,callStatus:'called',callBatchId:'old'},{id:'b',queueNumber:2,partySize:3,callStatus:'waiting'},{id:'c',queueNumber:3,partySize:4,callStatus:'waiting'},{id:'d',queueNumber:4,partySize:5,callStatus:'waiting'}].map(r=>({date,time,status:'reserved',qrEligible:true,...r}));
  const st={date,adminCallSlot:time,queueControls:{[slot]:{date,time,closed:false,callRevision:0}},reservations:rows,user:null};
  const records=new Map(rows.map(r=>['reservations/'+r.id,{...r}]));
  records.set('queueControls/'+slot,{...st.queueControls[slot]});
  records.set('slotCounts/'+slot,{date,time,count:14,nextQueueNumber:4,queueLedgerVersion:1,queueEntries:{1:{size:2,waiting:false},2:{size:3,waiting:true},3:{size:4,waiting:true},4:{size:5,waiting:true}}});
  const toasts=[],ledgerCalls=[],commits=[];let transactionCalls=0;
  const db={collection:name=>({doc:id=>({path:name+'/'+id})}),runTransaction:async callback=>{
    transactionCalls++;
    if(options.beforeTransaction)await options.beforeTransaction();
    const writes=[];
    const result=await callback({get:async ref=>{
      assert.equal(writes.length,0,'all reads precede writes');
      return{exists:records.has(ref.path),data:()=>structuredClone(records.get(ref.path))};
    },update:(ref,data)=>writes.push({ref,data,merge:true}),set:(ref,data,opts)=>writes.push({ref,data,merge:opts?.merge})});
    for(const write of writes)records.set(write.ref.path,{...(write.merge?records.get(write.ref.path):{}),...write.data});
    commits.push(writes);return result;
  }};
  const context={st,db,firebaseOn:options.firebaseOn!==false,firebase:{firestore:{FieldValue:{serverTimestamp:()=>123}}},console:{error(){}},todayDate:()=>date,
    isQueueClosed:(d,t)=>Boolean(st.queueControls[`${d}_${t.replace(':','')}`]?.closed),slotId:(d,t)=>`${d}_${t.replace(':','')}`,queueControlKey:(d,t)=>`${d}_${t.replace(':','')}`,
    queueRows:(d,t)=>st.reservations.filter(r=>r.date===d&&r.time===t&&r.status!=='cancelled'&&r.status!=='noshow'),partySizeOf:r=>r.partySize||1,totalPeople:rs=>rs.reduce((n,r)=>n+(r.partySize||1),0),
    takeWaitingByPeople:(rs,max)=>{const out=[];let n=0;for(const r of rs){if(out.length&&n+r.partySize>max)break;out.push(r);n+=r.partySize;if(n>=max)break;}return out;},newCallToken:()=> '초록 · 테스트',
    queueLedgerPatch:(data,before,after)=>{ledgerCalls.push({before,after});return{date:after.date,time:after.time,queueLedgerVersion:data.queueLedgerVersion,queueEntries:{...data.queueEntries,[after.queueNumber]:{size:after.partySize,waiting:after.callStatus!=='called'&&after.callStatus!=='passed'}}};},
    toast:text=>toasts.push(text),saveLocal(){},render(){},notifyCall(){}};
  vm.createContext(context);vm.runInContext(source,context);
  return{st,records,toasts,ledgerCalls,commits,run:code=>vm.runInContext(code,context),get transactionCalls(){return transactionCalls;}};
}

test('call transition and anonymous queue ledger commit together without changing capacity count',async()=>{
  const h=setup();await h.run('callNext(10)');
  assert.equal(h.records.get('reservations/a').callStatus,'passed');
  assert.equal(h.records.get('reservations/b').callStatus,'called');
  assert.equal(h.records.get('reservations/c').callStatus,'called');
  assert.equal(h.records.get('reservations/d').callStatus,'waiting');
  const ledger=h.records.get('slotCounts/'+slot);assert.equal(ledger.count,14);assert.equal(ledger.queueEntries[2].waiting,false);assert.equal(ledger.queueEntries[3].waiting,false);assert.equal(ledger.queueEntries[4].waiting,true);
  assert.equal(h.commits.length,1);assert.equal(h.records.get('queueControls/'+slot).callRevision,1);assert.match(h.toasts.at(-1),/7명/);
});

test('another administrator revision prevents a stale call from advancing again',async()=>{
  const h=setup();h.records.get('queueControls/'+slot).callRevision=1;
  await h.run('callNext(10)');assert.equal(h.commits.length,0);assert.match(h.toasts.at(-1),/상태가 바뀌/);
});

test('cancellation, moving slots, or checkin of a selected reservation rolls back the whole call',async()=>{
  for(const changes of [{status:'cancelled'},{status:'checkedin'},{time:'11:55'},{callStatus:'called'},{partySize:9},{queueNumber:12}]){
    const h=setup();Object.assign(h.records.get('reservations/b'),changes);await h.run('callNext(10)');assert.equal(h.commits.length,0);assert.equal(h.records.get('reservations/a').callStatus,'called');
  }
});

test('server-side queue closure is rechecked before call writes',async()=>{
  const h=setup();h.records.get('queueControls/'+slot).closed=true;await h.run('callNext(10)');assert.equal(h.commits.length,0);
});

test('rapid call, close, and toggle clicks share one in-flight guard',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);const h=setup({beforeTransaction:()=>pending});
  const first=h.run('callNext(10)');await h.run('callNext(10)');await h.run('closeCurrentCall()');await h.run('toggleQueueClosed()');
  assert.equal(h.transactionCalls,1);release();await first;assert.equal(h.commits.length,1);
});

test('date and slot selection cannot redirect an already-started call',async()=>{
  let release;const pending=new Promise(resolve=>release=resolve);const h=setup({beforeTransaction:()=>pending});
  const first=h.run('callNext(10)');h.st.date='2026-10-18';h.st.adminCallSlot='12:25';release();await first;
  assert.equal(h.records.get('reservations/b').time,time);assert.match(h.toasts.at(-1),/11:40/);assert.equal(h.records.has('queueControls/2026-10-18_1225'),false);
});

test('closing a call atomically changes active reservations and ledger only',async()=>{
  const h=setup();await h.run('closeCurrentCall()');assert.equal(h.records.get('reservations/a').callStatus,'passed');assert.equal(h.records.get('reservations/b').callStatus,'waiting');assert.equal(h.records.get('slotCounts/'+slot).count,14);assert.equal(h.ledgerCalls.length,1);
});

test('closing queue updates its active call and control in one transaction',async()=>{
  const h=setup();await h.run('toggleQueueClosed()');assert.equal(h.records.get('queueControls/'+slot).closed,true);assert.equal(h.records.get('reservations/a').callStatus,'passed');assert.equal(h.commits.length,1);assert.equal(h.records.get('slotCounts/'+slot).count,14);
});

test('stale toggle does not reopen a queue another administrator just closed',async()=>{
  const h=setup();h.records.get('queueControls/'+slot).closed=true;await h.run('toggleQueueClosed()');assert.equal(h.commits.length,0);assert.equal(h.records.get('queueControls/'+slot).closed,true);
});

test('local demo retains call and close behavior',async()=>{
  const h=setup({firebaseOn:false});await h.run('callNext(10)');assert.equal(h.st.reservations.find(r=>r.id==='a').callStatus,'passed');await h.run('closeCurrentCall()');assert.equal(h.st.reservations.find(r=>r.id==='b').callStatus,'passed');await h.run('toggleQueueClosed()');assert.equal(h.st.queueControls[slot].closed,true);assert.equal(h.transactionCalls,0);
});
