const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const script=fs.readFileSync(require('node:path').join(__dirname,'../firebase-messaging-sw.js'),'utf8');
const NOW=Date.UTC(2026,9,16,3,10);
function call(overrides={}){return{data:{title:'입장 호출',body:'10번',url:'./?open=my',reservationId:'2026-10-16_1234',callBatchId:'batch-1',expiresAt:String(NOW+120000),...overrides}}}
function worker(){
  const handlers={},events=[],messages=[];
  const clock={now:NOW};
  const self={registration:{scope:'https://example.test/seogu-bapsang/',showNotification:async(...args)=>messages.push(args),getNotifications:async()=>[]},addEventListener:(name,fn)=>handlers[name]=fn,
    clients:{claim(){},matchAll:async()=>[],openWindow:async url=>events.push(['open',url])},skipWaiting(){}};
  const firebase={initializeApp(){},messaging:()=>({onBackgroundMessage:fn=>handlers.background=fn})};
  vm.runInNewContext(script,{self,firebase,URL,console,Date:{now:()=>clock.now},importScripts(){assert.equal(typeof handlers.notificationclick,'function')}});
  return{self,handlers,events,messages,clock,click:async url=>{let promise;handlers.notificationclick({notification:{tag:'seogu-entry-call',data:{url},close(){}},stopImmediatePropagation(){},waitUntil(p){promise=p}});await promise}};
}
test('background payload displays the call with an existing icon',async()=>{const h=worker();await h.handlers.background({data:{title:'입장 호출',body:'10번',url:'./?open=my'}});assert.equal(h.messages[0][0],'입장 호출');assert.equal(h.messages[0][1].icon,'./icon-192.png')});
test('a current data-only call retains its stable call key',async()=>{const h=worker();await h.handlers.background(call());assert.equal(h.messages.length,1);assert.equal(h.messages[0][1].data.callKey,'2026-10-16_1234:batch-1')});
for(const expiresAt of [String(NOW-1),String(NOW),'',null,'not-a-date','Infinity',[],true]){
  test(`expired or malformed expiry ${JSON.stringify(expiresAt)} does not display an old call`,async()=>{const h=worker();await h.handlers.background(call({expiresAt}));assert.equal(h.messages.length,0)});
}
test('a call that expires while looking up notifications is not displayed',async()=>{const h=worker();h.self.registration.getNotifications=async()=>{h.clock.now=NOW+120000;return[]};await h.handlers.background(call());assert.equal(h.messages.length,0)});
test('FCM notification payload is not displayed a second time',async()=>{const h=worker();await h.handlers.background({...call(),notification:{title:'already displayed by FCM'}});assert.equal(h.messages.length,0)});
test('replayed and concurrent deliveries of the same call display once',async()=>{const h=worker();await Promise.all([h.handlers.background(call()),h.handlers.background(call())]);await h.handlers.background(call());assert.equal(h.messages.length,1)});
test('a new call batch can notify the same reservation again',async()=>{const h=worker();await h.handlers.background(call());await h.handlers.background(call({callBatchId:'batch-2'}));assert.equal(h.messages.length,2)});
test('already visible foreground or earlier-worker notification is not repeated',async()=>{const h=worker();h.self.registration.getNotifications=async options=>{assert.equal(options.tag,'seogu-entry-call');return[{data:{callKey:'2026-10-16_1234:batch-1'}}]};await h.handlers.background(call());assert.equal(h.messages.length,0)});
test('notification list lookup failure still permits a new call',async()=>{const h=worker();h.self.registration.getNotifications=async()=>{throw Error('lookup failed')};await h.handlers.background(call());assert.equal(h.messages.length,1)});
test('browsers without notification listing can still show a call',async()=>{const h=worker();delete h.self.registration.getNotifications;await h.handlers.background(call());assert.equal(h.messages.length,1)});
test('failed display does not prevent a later delivery retry',async()=>{const h=worker();let attempts=0;h.self.registration.showNotification=async(...args)=>{if(++attempts===1)throw Error('temporary display failure');h.messages.push(args)};await assert.rejects(h.handlers.background(call()),/temporary display failure/);await h.handlers.background(call());assert.equal(h.messages.length,1)});
test('notification opens the app ticket if no app window exists',async()=>{const h=worker();await h.click('./?open=my');assert.deepEqual(h.events,[['open','https://example.test/seogu-bapsang/?open=my']])});
test('existing window navigates to ticket before being focused',async()=>{const h=worker();h.self.clients.matchAll=async()=>[{url:h.self.registration.scope,focus:async()=>h.events.push('focus'),navigate:async url=>{h.events.push(['navigate',url]);return null}}];await h.click('./?open=my');assert.deepEqual(h.events,[['navigate','https://example.test/seogu-bapsang/?open=my'],'focus'])});
test('notification URLs cannot take the user outside the app',async()=>{for(const url of ['https://other.test/','https://example.test/elsewhere','javascript:alert(1)','http://[bad']){const h=worker();await h.click(url);assert.deepEqual(h.events,[['open','https://example.test/seogu-bapsang/?open=my']])}});
