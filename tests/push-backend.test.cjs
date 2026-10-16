const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const source=fs.readFileSync(require('node:path').join(__dirname,'../functions/index.js'),'utf8');
const hash=token=>createHash('sha256').update(token).digest('hex');
const NOW=Date.parse('2026-10-16T03:00:00Z');
const clone=value=>JSON.parse(JSON.stringify(value));

function setup(options={}){
  let now=options.now||NOW;
  const records=new Map(),sends=[],queries=[],logs=[];
  const snapshot=(collection,id)=>({id,ref:ref(collection,id),exists:records.has(`${collection}/${id}`),data:()=>records.get(`${collection}/${id}`)});
  const ref=(collection,id)=>({id,path:`${collection}/${id}`,get:async()=>snapshot(collection,id),set:async data=>{
    if(options.dbFail)throw Object.assign(Error('db unavailable'),{code:'unavailable'});
    records.set(`${collection}/${id}`,{...data});
  }});
  const db={
    collection:name=>({doc:id=>ref(name,id),where:(field,operator,value)=>({get:async()=>{
      queries.push({name,field,operator,value});
      return{docs:[...records].filter(([key,data])=>key.startsWith(`${name}/`)&&data[field]===value).map(([key])=>snapshot(name,key.slice(name.length+1)))};
    }})}),
    runTransaction:async callback=>{
      if(options.dbFail)throw Object.assign(Error('db unavailable'),{code:'unavailable'});
      const writes=[];
      const result=await callback({get:async reference=>{
        assert.equal(writes.length,0,'Firestore transaction must read before writing');
        const separator=reference.path.indexOf('/');
        return snapshot(reference.path.slice(0,separator),reference.path.slice(separator+1));
      },update:(reference,changes)=>writes.push([reference,changes,false]),set:(reference,changes)=>writes.push([reference,changes,true])});
      for(const [reference,changes,replace] of writes)records.set(reference.path,{...(replace?{}:records.get(reference.path)),...changes});
      return result;
    }
  };
  const exports={};
  const wrap=(options,handler)=>Object.assign(handler,{options});
  const mockModules={
    'firebase-functions/v2/firestore':{onDocumentUpdated:wrap},
    'firebase-functions/v2/https':{onRequest:wrap},
    'firebase-functions/params':{defineString:(name,config)=>{assert.equal(name,'WEB_PUSH_VAPID_KEY');assert.equal(config.default,'');return{value:()=>options.vapid||''}}},
    'firebase-admin/app':{initializeApp(){}},
    'firebase-admin/firestore':{getFirestore:()=>db},
    'firebase-admin/messaging':{getMessaging:()=>({sendEachForMulticast:async message=>{
      sends.push(clone(message));
      if(options.sendFailure)throw Object.assign(Error('network failure'),{code:'messaging/server-unavailable'});
      return{responses:message.tokens.map(token=>options.tokenErrors&&options.tokenErrors[token]?{success:false,error:{code:options.tokenErrors[token]}}:{success:true})};
    }})}
  };
  class FixedDate extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  vm.runInNewContext(source,{exports,require:name=>name==='node:crypto'?require(name):mockModules[name],Date:FixedDate,console:{error:(...args)=>logs.push(args),warn:(...args)=>logs.push(args)}});
  return{exports,records,sends,queries,logs,options,setNow:value=>{now=value;},
    device:(token,emp='1234',extra={})=>records.set(`pushTokens/${hash(token)}`,{token,emp,enabled:true,...extra}),
    call:async(overrides={},latest={},before={callStatus:'waiting'})=>{
      const after={emp:'1234',status:'reserved',callStatus:'called',date:'2026-10-16',callBatchId:'batch-1',calledAt:{toMillis:()=>now-5000},queueNumber:8,time:'12:00',callToken:'초록 · 하나',...overrides};
      if(latest!==null)records.set('reservations/res-1',{...after,...latest});
      return exports.notifyEntryCall({params:{reservationId:'res-1'},data:{before:{data:()=>before},after:{data:()=>after}}});
    }
  };
}

async function request(handler,body,method='POST'){
  const response={code:200,headers:{},status(code){this.code=code;return this;},set(key,value){this.headers[key]=value;return this;},json(data){this.body=clone(data);return this;}};
  await handler({method,body},response);
  return response;
}

test('public push configuration returns only availability and public browser key',async()=>{
  const empty=await request(setup().exports.getPushConfig,null,'GET');
  assert.deepEqual(empty.body,{enabled:false,vapidKey:''});
  const enabled=await request(setup({vapid:' public-key '}).exports.getPushConfig,null,'GET');
  assert.deepEqual(enabled.body,{enabled:true,vapidKey:'public-key'});
  assert.equal(enabled.headers['Cache-Control'],'no-store');
});

test('each phone has a distinct device record without employee name or department',async()=>{
  const h=setup();
  for(const token of ['phone-one','phone-two'])assert.equal((await request(h.exports.registerPushToken,{token,emp:'1234',name:'not stored',dept:'not stored'})).body.ok,true);
  assert.equal(h.records.size,2);
  for(const token of ['phone-one','phone-two']){
    const device=h.records.get(`pushTokens/${hash(token)}`);
    assert.equal(device.emp,'1234');
    assert.equal(device.token,token);
    assert.equal('name' in device,false);
    assert.equal('dept' in device,false);
  }
});

test('one device can change employee without creating another recipient record',async()=>{
  const h=setup();
  await request(h.exports.registerPushToken,{token:'same-phone',emp:'1234'});
  await request(h.exports.registerPushToken,{token:'same-phone',emp:'5678'});
  assert.equal(h.records.size,1);
  assert.equal(h.records.get(`pushTokens/${hash('same-phone')}`).emp,'5678');
});

test('invalid bodies and HTTP methods cannot register or remove devices',async()=>{
  const h=setup();
  for(const body of [null,{}, {token:{},emp:'1234'},{token:'',emp:'1234'},{token:'  ',emp:'1234'},{token:'x'.repeat(4097),emp:'1234'},{token:'phone',emp:'12345'}]){
    assert.equal((await request(h.exports.registerPushToken,body)).code,400);
    assert.equal((await request(h.exports.unregisterPushToken,body)).code,400);
  }
  assert.equal((await request(h.exports.registerPushToken,{token:'phone',emp:'1234'},'GET')).code,405);
  assert.equal((await request(h.exports.unregisterPushToken,{token:'phone',emp:'1234'},'GET')).code,405);
  assert.equal((await request(h.exports.getPushConfig,null)).code,405);
  assert.equal(h.records.size,0);
});

test('database failure is not reported as a connected or disconnected device',async()=>{
  const h=setup({dbFail:true});
  for(const handler of [h.exports.registerPushToken,h.exports.unregisterPushToken]){
    const result=await request(handler,{token:'phone',emp:'1234'});
    assert.equal(result.code,503);assert.equal(result.body.ok,undefined);
  }
  assert.equal(h.logs.length,2);
  assert.ok(!JSON.stringify(h.logs).includes('phone'));
});

test('unregister affects only the requested employee and matching phone, including legacy duplicate',async()=>{
  const h=setup();h.device('phone-one');h.device('phone-two');
  h.records.set('pushTokens/1234',{token:'phone-one',emp:'1234',enabled:true});
  await request(h.exports.unregisterPushToken,{token:'phone-one',emp:'5678'});
  assert.equal(h.records.get(`pushTokens/${hash('phone-one')}`).enabled,true);
  await request(h.exports.unregisterPushToken,{token:'phone-one',emp:'1234'});
  assert.equal(h.records.get(`pushTokens/${hash('phone-one')}`).enabled,false);
  assert.equal(h.records.get('pushTokens/1234').enabled,false);
  assert.equal(h.records.get(`pushTokens/${hash('phone-two')}`).enabled,true);
});

test('a real call sends all enabled employee devices a data-only short-lived message',async()=>{
  const h=setup();h.device('phone-one');h.device('phone-two');h.device('disabled','1234',{enabled:false});h.device('someone-else','5678');
  await h.call();
  assert.equal(h.sends.length,1);
  const message=h.sends[0];
  assert.deepEqual(message.tokens,['phone-one','phone-two']);
  assert.equal(message.notification,undefined);
  assert.equal(message.data.emp,'1234');assert.equal(message.data.reservationId,'res-1');assert.equal(message.data.callBatchId,'batch-1');
  assert.equal(message.data.expiresAt,String(NOW+115000));
  assert.equal(message.webpush.headers.TTL,'115');
  assert.equal(message.webpush.headers.Urgency,'high');
  assert.match(message.data.body,/008번/);
  assert.equal(h.exports.notifyEntryCall.options.retry,true);
});

test('non-call updates, repeated status updates, missing batches and invalid employees never send',async()=>{
  for(const values of [{callStatus:'waiting'},{status:'cancelled'},{status:'checkedin'},{status:'noshow'},{callBatchId:''},{emp:'invalid'}]){
    const h=setup();h.device('phone');await h.call(values);assert.equal(h.sends.length,0);
  }
  const h=setup();h.device('phone');await h.call({}, {},{callStatus:'called',callBatchId:'batch-1'});assert.equal(h.sends.length,0);
});

test('latest reservation recheck rejects cancellation, entry, passed call, deletion or another batch',async()=>{
  for(const latest of [null,{status:'cancelled'},{status:'checkedin'},{callStatus:'passed'},{callBatchId:'batch-2'},{date:'2026-10-15'},{emp:'5678'}]){
    const h=setup();h.device('phone');await h.call({},latest);assert.equal(h.sends.length,0);
  }
});

test('expired, missing, future and wrong-day calls never send',async()=>{
  for(const values of [{calledAt:NOW-120000},{calledAt:undefined},{calledAt:NOW+31000},{date:'2026-10-15'},{date:'2026-10-17'}]){
    const h=setup();h.device('phone');await h.call(values);assert.equal(h.sends.length,0);
  }
});

test('Korean calendar date is used across UTC midnight boundary',async()=>{
  const h=setup({now:Date.parse('2026-10-16T15:01:00Z')});h.device('phone');
  await h.call({date:'2026-10-17'});
  assert.equal(h.sends.length,1);
});

test('a retried event skips devices already sent and a new call batch can notify again',async()=>{
  const h=setup();h.device('phone');await h.call();await h.call();
  assert.equal(h.sends.length,1);
  await h.call({callBatchId:'batch-2'}, {},{callStatus:'called',callBatchId:'batch-1'});
  assert.equal(h.sends.length,2);
});

test('normal page reconnect preserves delivery markers while dropping legacy profile fields',async()=>{
  const h=setup();h.device('phone','1234',{name:'old name',dept:'old department'});
  await h.call();
  await request(h.exports.registerPushToken,{token:'phone',emp:'1234'});
  await h.call();assert.equal(h.sends.length,1);
  const device=h.records.get(`pushTokens/${hash('phone')}`);
  assert.equal('name' in device,false);assert.equal('dept' in device,false);
  assert.deepEqual(clone(device.sentCallKeys),['res-1:batch-1']);
});

test('out-of-order call delivery keeps recent markers rather than only the last completed event',async()=>{
  const h=setup();h.device('phone');
  await h.call({callBatchId:'batch-2'});
  await h.call({callBatchId:'batch-1'});
  await h.call({callBatchId:'batch-2'});
  assert.equal(h.sends.length,2);
  assert.deepEqual(clone(h.records.get(`pushTokens/${hash('phone')}`).sentCallKeys),['res-1:batch-2','res-1:batch-1']);
});

test('legacy employee-keyed registrations still work and duplicate tokens send only once',async()=>{
  const h=setup();h.records.set('pushTokens/1234',{token:'old-phone',emp:'1234',enabled:true});
  await h.call();assert.deepEqual(h.sends[0].tokens,['old-phone']);
  h.device('old-phone');await h.call({callBatchId:'batch-2'});
  assert.deepEqual(h.sends[1].tokens,['old-phone']);
});

test('legacy tokens cannot revive a disabled phone or a phone now used by another employee',async()=>{
  for(const owner of [{emp:'1234',enabled:false},{emp:'5678',enabled:true}]){
    const h=setup();h.records.set('pushTokens/1234',{token:'old-phone',emp:'1234',enabled:true});
    h.device('old-phone',owner.emp,{enabled:owner.enabled});
    await h.call();assert.equal(h.sends.length,0);
  }
});

test('only explicit invalid-token errors disable devices; temporary failure retries only unsent devices',async()=>{
  const h=setup({tokenErrors:{expired:'messaging/registration-token-not-registered',temporary:'messaging/server-unavailable'}});
  h.device('good');h.device('expired');h.device('temporary');
  await assert.rejects(h.call(),/PUSH_DELIVERY_RETRY/);
  assert.equal(h.records.get(`pushTokens/${hash('expired')}`).enabled,false);
  assert.equal(h.records.get(`pushTokens/${hash('temporary')}`).enabled,true);
  assert.equal(h.records.get(`pushTokens/${hash('good')}`).lastCallKey,'res-1:batch-1');
  h.options.tokenErrors={};await h.call();
  assert.deepEqual(h.sends[1].tokens,['temporary']);
});

test('transport failure preserves all devices and propagates for a bounded retry',async()=>{
  const h=setup({sendFailure:true});h.device('phone');
  await assert.rejects(h.call(),/network failure/);
  assert.equal(h.records.get(`pushTokens/${hash('phone')}`).enabled,true);
  assert.equal(h.records.get(`pushTokens/${hash('phone')}`).lastCallKey,undefined);
});

test('multicast groups never exceed the FCM 500-device limit',async()=>{
  const h=setup();for(let i=0;i<501;i++)h.device(`phone-${i}`);
  await h.call();assert.deepEqual(h.sends.map(message=>message.tokens.length),[500,1]);
});
