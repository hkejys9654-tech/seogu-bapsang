const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(process.env.CALL_FLOW_HTML||path.join(__dirname,'../index.html'),'utf8');
function functionSource(name){const starts=[...html.matchAll(/^(?:async )?function [A-Za-z_$][\w$]*\(/gm)];const index=starts.findIndex(m=>m[0].includes(`function ${name}(`));assert.ok(index>=0);return html.slice(starts[index].index,starts[index+1]?.index||html.length);}
const source=['takeWaitingByPeople','setCallSize','callPanel'].map(functionSource).join('\n')+'\n'+html.slice(html.indexOf('async function callNext(size){'),html.indexOf('async function addNotice(){'));
const SLOTS=JSON.parse(html.match(/^const SLOTS=(\[[^;]+\]);/m)[1]);
const date='2026-10-17',time='11:40',slot=`${date}_1140`;
function setup(options={}){
  const rows=(options.rows||[{id:'a',queueNumber:1,partySize:2,callStatus:'called',callBatchId:'old'},{id:'b',queueNumber:2,partySize:3,callStatus:'waiting'},{id:'c',queueNumber:3,partySize:4,callStatus:'waiting'},{id:'d',queueNumber:4,partySize:5,callStatus:'waiting'}]).map(r=>({date,time,status:'reserved',qrEligible:true,...r}));
  const st={date,adminCallSlot:time,adminCallSize:10,queueControls:{[slot]:{date,time,closed:false,callRevision:0}},reservations:rows,user:null};
  const records=new Map(rows.map(r=>['reservations/'+r.id,{...r}]));
  records.set('queueControls/'+slot,{...st.queueControls[slot]});
  records.set('slotCounts/'+slot,{date,time,count:rows.reduce((n,r)=>n+r.partySize,0),nextQueueNumber:Math.max(...rows.map(r=>r.queueNumber)),queueLedgerVersion:1,queueEntries:Object.fromEntries(rows.map(r=>[r.queueNumber,{size:r.partySize,waiting:r.callStatus==='waiting'}]))});
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
  const context={st,db,SLOTS,pretty:value=>value,esc:value=>String(value||''),firebaseOn:options.firebaseOn!==false,firebase:{firestore:{FieldValue:{serverTimestamp:()=>123}}},console:{error(){}},todayDate:()=>date,
    isQueueClosed:(d,t)=>Boolean(st.queueControls[`${d}_${t.replace(':','')}`]?.closed),slotId:(d,t)=>`${d}_${t.replace(':','')}`,queueControlKey:(d,t)=>`${d}_${t.replace(':','')}`,
    queueRows:(d,t)=>st.reservations.filter(r=>r.date===d&&r.time===t&&r.status!=='cancelled'&&r.status!=='noshow'),partySizeOf:r=>r.partySize||1,totalPeople:rs=>rs.reduce((n,r)=>n+(r.partySize||1),0),
    newCallToken:()=> '초록 · 테스트',
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

test('custom counts from one through fifty call exactly that many individual reservations',async()=>{
  for(const size of [1,7,17,50]){
    const rows=Array.from({length:50},(_,i)=>({id:String(i+1),queueNumber:i+1,partySize:1,callStatus:'waiting'}));
    const h=setup({rows});await h.run(`callNext(${size})`);
    assert.equal([...h.records].filter(([key,r])=>key.startsWith('reservations/')&&r.callStatus==='called').length,size);
    assert.equal(h.records.get('slotCounts/'+slot).count,50);
  }
});

test('a choice smaller than the first party never overcalls, skips it, or ends the current call',async()=>{
  const h=setup();await h.run('callNext(1)');
  assert.equal(h.transactionCalls,0);assert.equal(h.records.get('reservations/a').callStatus,'called');
  assert.match(h.toasts.at(-1),/맨 앞 단체는 3명/);
  await h.run('callNext(5)');assert.equal(h.records.get('reservations/b').callStatus,'called');
  assert.equal(h.records.get('reservations/c').callStatus,'waiting');assert.equal(h.records.get('reservations/d').callStatus,'waiting');
  assert.match(h.toasts.at(-1),/3명/);
});

test('invalid custom counts cannot start a transaction',async()=>{
  for(const input of ['0','-1','1.5','51','NaN','Infinity','undefined','"invalid"']){
    const h=setup();await h.run(`callNext(${input})`);
    assert.equal(h.transactionCalls,0);assert.equal(h.records.get('reservations/a').callStatus,'called');
  }
});

test('dropdown renders every count and keeps the selected value after live renders and calls',async()=>{
  const h=setup();h.run('setCallSize("17")');
  for(let i=0;i<2;i++){
    const panel=h.run('callPanel()');
    assert.equal((panel.match(/<option /g)||[]).length,50);
    assert.match(panel,/<option value="17" selected>17명/);assert.match(panel,/최대 17명 호출/);
    assert.equal(panel.includes('onclick="callNext(10)"'),false);
  }
  await h.run('callNext(st.adminCallSize)');assert.equal(h.st.adminCallSize,17);
  h.run('setCallSize("1")');assert.match(h.run('callPanel()'),/맨 앞 단체는 3명/);
  h.run('callNext.pending=true;setCallSize("12")');assert.equal(h.st.adminCallSize,1);
  assert.match(h.run('callPanel()'),/호출 중…/);
});
