const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const source=html.slice(html.indexOf('function notificationPermission()'),html.indexOf('function toast('));
function setup(options={}){
  const notices=[],requests=[],toasts=[],stored=new Map([['sg_push_enabled','1']]);
  const registration={active:{state:'activated'},showNotification:async(...args)=>notices.push(args)};
  const client={getToken:async()=>options.token===undefined?'token-for-device':options.token};
  const messaging=()=>client;messaging.isSupported=async()=>options.supported!==false;
  const context={console:{warn(){}},Promise,setTimeout,clearTimeout,AbortController,
    st:{user:options.user===false?null:{emp:'1234',name:'테스트',dept:'기획실'}},firebaseOn:options.firebaseOn!==false,
    firebase:{messaging},PUSH_VAPID_KEY:options.configured?'public-vapid-key':'',PUSH_REGISTER_ENDPOINT:'https://example.test/push',
    Notification:{permission:options.permission||'granted',requestPermission:async()=>options.requestResult||'granted'},
    navigator:{serviceWorker:{register:async()=>{if(options.workerFail)throw Error('worker failed');return registration}},vibrate(){}},
    localStorage:{removeItem:key=>stored.delete(key)},render(){},toast:message=>toasts.push(message),todayDate:()=> '2026-10-16',queueNumberFor:r=>r.queueNumber,
    fetch:async(url,request)=>{requests.push({url,request});if(options.fetchFail)throw Error('fetch failed');return{ok:options.httpOK!==false,json:async()=>{if(options.invalidJSON)throw Error('invalid json');return options.response||{ok:true}}}}
  };
  vm.createContext(context);
  vm.runInContext('let messaging=null,callNotificationRegistration=null,callWorkerPending=null,pushSetupPending=null;let pushConnection={mode:"idle",emp:"",reason:""};'+source,context);
  return{context,notices,requests,toasts,stored,registration,run:code=>vm.runInContext(code,context)};
}
test('permission alone is not presented as connected',()=>{const h=setup();assert.equal(h.run('pushConnectionView().on'),undefined);assert.match(h.run('pushConnectionView().label'),/연결 확인 필요/)});
test('blank VAPID enables only app-open notifications and clears stale success flag',async()=>{const h=setup();await h.run('setupPushMessaging(true)');assert.equal(h.run('pushConnection.mode'),'local');assert.equal(h.requests.length,0);assert.equal(h.stored.has('sg_push_enabled'),false);assert.match(h.toasts.at(-1),/앱 실행 중/);assert.match(h.run('pushConnectionView().detail'),/앱을 닫은 뒤의 알림은 아직 연결되지/)});
test('background status requires both a token and confirmed server registration',async()=>{const h=setup({configured:true});await h.run('setupPushMessaging(true)');assert.equal(h.run('pushConnection.mode'),'push');assert.equal(h.requests.length,1);assert.deepEqual(JSON.parse(h.requests[0].request.body),{token:'token-for-device',emp:'1234',name:'테스트',orgKey:'',dept:'기획실'});assert.match(h.toasts.at(-1),/백그라운드/)});
for(const [name,options] of [['empty token',{token:''}],['non-OK response',{httpOK:false}],['unconfirmed response',{response:{ok:false}}],['invalid JSON',{invalidJSON:true}],['network failure',{fetchFail:true}]]){
  test(name+' never reports background registration success',async()=>{const h=setup({configured:true,...options});await h.run('setupPushMessaging(true)');assert.equal(h.run('pushConnection.mode'),'local');assert.equal(h.run('pushConnection.reason'),'failed');assert.match(h.run('pushConnectionView().label'),/추가 연결 실패/);assert.ok(!h.toasts.some(s=>s.includes('등록되었습니다')))});
}
test('unsupported FCM still permits app-open notifications',async()=>{const h=setup({configured:true,supported:false});await h.run('setupPushMessaging(true)');assert.equal(h.run('pushConnection.mode'),'local');assert.equal(h.requests.length,0)});
test('denied permission asks for browser settings, not successful registration',async()=>{const h=setup({permission:'denied'});await h.run('setupPushMessaging(true)');assert.equal(h.requests.length,0);assert.match(h.run('pushConnectionView().label'),/차단/);assert.match(h.toasts[0],/사이트 설정/)});
test('worker failure is a connection failure even with granted permission',async()=>{const h=setup({workerFail:true});await h.run('setupPushMessaging(true)');assert.equal(h.run('pushConnection.mode'),'error');assert.match(h.run('pushConnectionView().label'),/실패/)});
test('automatic setup is quiet when no user is registered',async()=>{const h=setup({user:false});await h.run('setupPushMessaging(false)');assert.equal(h.toasts.length,0);assert.equal(h.requests.length,0)});
test('repeated connection clicks reuse the in-flight setup',async()=>{const h=setup({configured:true});await Promise.all([h.run('setupPushMessaging(true)'),h.run('setupPushMessaging(true)')]);assert.equal(h.requests.length,1)});
test('new employee never sees previous employee connection status',async()=>{const h=setup({configured:true});await h.run('setupPushMessaging(true)');h.context.st.user={emp:'5678'};assert.equal(h.run('pushConnectionView().on'),undefined)});
test('notifications register a worker on demand rather than waiting forever on ready',async()=>{const h=setup();await h.run('showCallNotification("입장", "지금 입장")');assert.equal(h.notices.length,1);assert.equal(h.notices[0][1].icon,'./icon-192.png')});
test('first-install activation is awaited before using a worker',async()=>{const h=setup();let changed;const worker={state:'installing',addEventListener:(type,listener)=>{changed=listener},removeEventListener(){}};h.registration.active=null;h.registration.installing=worker;const pending=h.run('ensureCallWorker()');await new Promise(resolve=>setImmediate(resolve));worker.state='activated';h.registration.active=worker;changed();assert.equal(await pending,h.registration)});
test('past, canceled, and other employee calls cannot trigger local notifications',()=>{const h=setup();h.context.showCallNotification=()=>h.notices.push('called');for(const values of [{date:'2026-10-15'},{status:'cancelled'},{emp:'5678'}]){h.context.call={emp:'1234',date:'2026-10-16',status:'reserved',callStatus:'called',...values};h.run('notifyCall(call)')}assert.equal(h.notices.length,0)});
test('notification timeout rejects instead of hanging',async()=>{const h=setup();await assert.rejects(h.run('notificationTimeout(new Promise(()=>{}),5)'),/NOTIFICATION_TIMEOUT/)});
test('connected background push owns hidden-tab notifications; local mode still notifies',()=>{const h=setup();h.context.document={visibilityState:'hidden'};h.context.showCallNotification=()=>h.notices.push('called');h.context.call={emp:'1234',date:'2026-10-16',status:'reserved',callStatus:'called'};h.run('pushConnection={mode:"push",emp:"1234"};notifyCall(call)');assert.equal(h.notices.length,0);h.run('pushConnection.mode="local";notifyCall(call)');assert.equal(h.notices.length,1)});
