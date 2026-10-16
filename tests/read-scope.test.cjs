const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const source=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
const DAY='2026-10-17';
function setup(){
  const gets=[],listeners=[],notices=[],toasts=[],events={};
  const records=new Map();
  for(const time of ['1140','1155','1210','1225','1240'])records.set(`slotCounts/${DAY}_${time}`,{count:12,queueLedgerVersion:1,queueEntries:{}});
  function snap(id,data,cache=false){return{id,exists:data!==undefined,data:()=>data,metadata:{fromCache:cache},ref:{path:id}};}
  function query(name,filters=[],order=null,limit=null,id=null){
    const target={name,filters,order,limit,id,path:id===null?name:`${name}/${id}`};
    return{
      doc:documentId=>query(name,filters,order,limit,documentId),
      where:(...filter)=>query(name,[...filters,filter],order,limit,id),
      orderBy:(...value)=>query(name,filters,value,limit,id),limit:value=>query(name,filters,order,value,id),
      get:async options=>{
        gets.push({...target,options});
        if(id!==null)return snap(id,records.get(target.path));
        const docs=[...records].filter(([key,data])=>key.startsWith(name+'/')&&filters.every(([field,operator,value])=>operator==='=='&&data[field]===value)).slice(0,limit===null?undefined:limit).map(([key,data])=>snap(key.split('/').at(-1),data));
        return{docs,metadata:{fromCache:false},forEach:fn=>docs.forEach(fn)};
      },
      onSnapshot:(...args)=>{
        const callback=args.find(value=>typeof value==='function'),error=args.filter(value=>typeof value==='function')[1];
        const listener={...target,callback,error,active:true};listeners.push(listener);return()=>{listener.active=false};
      }
    };
  }
  const db={collection:name=>query(name),runTransaction:()=>{throw Error('Unexpected migration or transaction in read-scope test')}};
  const firestore=()=>db;firestore.FieldValue={serverTimestamp:()=>1};
  const context={__db:db,__notices:notices,__toasts:toasts,console:{error(){},warn(){}},Promise,Date,URLSearchParams,URL,AbortController,Map,Set,
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},navigator:{onLine:true},location:{search:'',reload(){}},
    document:{addEventListener:(name,fn)=>{events[name]=fn;},getElementById:()=>null,querySelectorAll:()=>[],visibilityState:'visible'},window:{addEventListener:(name,fn)=>{events[name]=fn;}},
    localStorage:{getItem:()=>null,setItem(){},removeItem(){}},firebase:{initializeApp(){},firestore},prompt:()=> '1234',confirm:()=>true};
  vm.createContext(context);vm.runInContext(source,context);
  vm.runInContext(`render=()=>{};toast=message=>__toasts.push(message);stopScanner=()=>{};populateOrganizationSelect=()=>{};populateDeptSelect=()=>{};updateLoginState=()=>{};migrateUserOrganization=()=>{};notifyCall=r=>__notices.push(r);todayDate=()=> '${DAY}';st.date='${DAY}';st.user={emp:'1234',name:'Test',orgKey:'planning',dept:'기획실'};`,context);
  const run=code=>vm.runInContext(code,context);
  return{gets,listeners,notices,toasts,records,events,run,flush:()=>new Promise(resolve=>setImmediate(resolve)),
    async start(){run('firebaseOn=true;db=__db;refreshDataScope(true)');await this.flush();},
    active:path=>listeners.filter(listener=>listener.active&&listener.path===path),
    emit(listener,data,cache=false){if(listener.id!==null)listener.callback(snap(listener.id,data,cache));else{const docs=data.map((item,i)=>snap(item.id||String(i),item,cache));listener.callback({docs,metadata:{fromCache:cache},forEach:fn=>docs.forEach(fn)});}}
  };
}
const reservation=(changes={})=>({emp:'1234',date:DAY,time:'11:40',status:'reserved',qrEligible:true,queueNumber:5,partySize:1,callStatus:'waiting',...changes});

test('ordinary employee listens to only own reservation and own penalty, never full collections',async()=>{
  const h=setup();await h.start();
  assert.deepEqual(h.listeners.filter(l=>l.active).map(l=>l.path).sort(),[`penalties/1234`,`reservations/${DAY}_1234`]);
  assert.equal(h.gets.filter(g=>g.name==='slotCounts').length,5);
  assert.equal(h.gets.filter(g=>g.name==='queueControls').length,5);
  assert.equal(h.gets.some(g=>['reservations','penalties'].includes(g.name)&&g.id===null),false);
});

test('reservation opens only its own anonymous queue listener and checkin stops it',async()=>{
  const h=setup();await h.start();const own=h.active(`reservations/${DAY}_1234`)[0];
  h.emit(own,reservation());assert.equal(h.active(`slotCounts/${DAY}_1140`).length,1);
  h.emit(own,reservation());assert.equal(h.active(`slotCounts/${DAY}_1140`).length,1);
  h.emit(own,reservation({time:'11:55'}));assert.equal(h.active(`slotCounts/${DAY}_1140`).length,0);assert.equal(h.active(`slotCounts/${DAY}_1155`).length,1);
  h.emit(own,reservation({status:'checkedin',time:'11:55'}));assert.equal(h.listeners.some(l=>l.active&&l.name==='slotCounts'),false);
});

test('overview reads five slots once and has a 60 second refresh cooldown',async()=>{
  const h=setup();await h.start();await h.run('refreshOverview()');await h.run('refreshOverview()');
  assert.equal(h.gets.filter(g=>g.name==='slotCounts').length,5);
  h.run('overviewAt=Date.now()-61000');await h.run('refreshOverview()');assert.equal(h.gets.filter(g=>g.name==='slotCounts').length,10);
  assert.equal(h.listeners.some(l=>l.name==='slotCounts'),false);
});

test('admin full-list listeners exist only in unlocked admin view and close on return',async()=>{
  const h=setup();await h.start();h.run('st.tab="more";unlockAdmin()');await h.flush();
  assert.equal(h.listeners.filter(l=>l.active&&l.name==='reservations'&&l.id===null).length,1);
  assert.equal(h.listeners.filter(l=>l.active&&l.name==='queueControls'&&l.id===null).length,1);
  assert.equal(h.listeners.some(l=>l.active&&l.name==='penalties'&&l.id===null),false);
  h.run('closeAdmin()');await h.flush();
  assert.equal(h.listeners.some(l=>l.active&&l.id===null),false);
  assert.equal(h.active(`reservations/${DAY}_1234`).length,1);
});

test('logout ends personal listeners and stale callbacks cannot restore someone else data',async()=>{
  const h=setup();await h.start();const own=h.active(`reservations/${DAY}_1234`)[0];h.emit(own,reservation());
  const queue=h.active(`slotCounts/${DAY}_1140`)[0];h.run('logout()');await h.flush();
  assert.equal(h.listeners.some(l=>l.active),false);
  h.emit(own,reservation({callStatus:'called',callBatchId:'old'}));h.emit(queue,{queueLedgerVersion:1,queueEntries:{1:{size:99,waiting:true}}});
  assert.equal(h.run('st.reservations.length'),0);assert.equal(h.notices.length,0);assert.equal(h.run('ownQueueKey'),'');
});

test('midnight changes scope and ignores yesterday listener results',async()=>{
  const h=setup();await h.start();const previous=h.active(`reservations/${DAY}_1234`)[0];h.emit(previous,reservation());
  h.run('todayDate=()=>"2026-10-18";refreshDataScope()');await h.flush();
  assert.equal(previous.active,false);assert.equal(h.active('reservations/2026-10-18_1234').length,1);assert.equal(h.listeners.some(l=>l.active&&l.name==='slotCounts'),false);
  h.emit(previous,reservation({callStatus:'called'}));assert.equal(h.run('st.reservations.length'),0);
});

test('anonymous queue counts waiting group sizes and excludes called, zero-size, own and later entries',async()=>{
  const h=setup();await h.start();h.emit(h.active(`reservations/${DAY}_1234`)[0],reservation());
  h.emit(h.active(`slotCounts/${DAY}_1140`)[0],{queueLedgerVersion:1,queueEntries:{1:{size:3,waiting:true},2:{size:4,waiting:false},3:{size:0,waiting:true},4:{size:2,waiting:true},5:{size:1,waiting:true},6:{size:10,waiting:true}}});
  assert.equal(h.run('queueAhead(st.reservations[0])'),5);
  h.emit(h.active(`slotCounts/${DAY}_1140`)[0],{queueLedgerVersion:1,queueEntries:{}},true);assert.equal(h.run('queueAhead(st.reservations[0])'),null);
  h.emit(h.active(`slotCounts/${DAY}_1140`)[0],{queueEntries:{1:{size:3,waiting:true}}});assert.equal(h.run('queueAhead(st.reservations[0])'),null);
});

test('cache call followed by confirmed server call notifies once after reconnect',async()=>{
  const h=setup();await h.start();const own=h.active(`reservations/${DAY}_1234`)[0];h.emit(own,reservation());
  const called=reservation({callStatus:'called',callBatchId:'batch-1'});h.emit(own,called,true);assert.equal(h.notices.length,0);
  h.emit(own,called);h.emit(own,called);assert.equal(h.notices.length,1);
});

test('initial confirmed called reservation notifies once even when cache already showed called',async()=>{
  const h=setup();await h.start();const own=h.active(`reservations/${DAY}_1234`)[0];const called=reservation({callStatus:'called',callBatchId:'batch-1'});
  h.emit(own,called,true);h.emit(own,called);h.emit(own,called);assert.equal(h.notices.length,1);
});

test('new call batch can notify when status remained called',async()=>{
  const h=setup();await h.start();const own=h.active(`reservations/${DAY}_1234`)[0];h.emit(own,reservation());
  h.emit(own,reservation({callStatus:'called',callBatchId:'batch-1'}));h.emit(own,reservation({callStatus:'called',callBatchId:'batch-2'}));assert.equal(h.notices.length,2);
});

test('connection retry replaces failed listeners instead of accumulating subscriptions',async()=>{
  const h=setup();await h.start();const own=h.active(`reservations/${DAY}_1234`)[0];own.error(Error('offline'));assert.equal(h.run('dataState.reservation'),'error');
  h.run('retryConnection()');await h.flush();assert.equal(own.active,false);assert.equal(h.active(`reservations/${DAY}_1234`).length,1);
  assert.equal(h.listeners.filter(l=>l.active).length,2);assert.equal(h.gets.filter(g=>g.name==='notices').at(-1).limit,10);
});
