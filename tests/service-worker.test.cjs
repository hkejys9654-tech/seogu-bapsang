const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const script=fs.readFileSync(require('node:path').join(__dirname,'../firebase-messaging-sw.js'),'utf8');
function worker(){
  const handlers={},events=[],messages=[];
  const self={registration:{scope:'https://example.test/seogu-bapsang/',showNotification:async(...args)=>messages.push(args)},addEventListener:(name,fn)=>handlers[name]=fn,
    clients:{claim(){},matchAll:async()=>[],openWindow:async url=>events.push(['open',url])},skipWaiting(){}};
  const firebase={initializeApp(){},messaging:()=>({onBackgroundMessage:fn=>handlers.background=fn})};
  vm.runInNewContext(script,{self,firebase,URL,console,importScripts(){assert.equal(typeof handlers.notificationclick,'function')}});
  return{self,handlers,events,messages,click:async url=>{let promise;handlers.notificationclick({notification:{tag:'seogu-entry-call',data:{url},close(){}},stopImmediatePropagation(){},waitUntil(p){promise=p}});await promise}};
}
test('background payload displays the call with an existing icon',async()=>{const h=worker();await h.handlers.background({data:{title:'입장 호출',body:'10번',url:'./?open=my'}});assert.equal(h.messages[0][0],'입장 호출');assert.equal(h.messages[0][1].icon,'./icon-192.png')});
test('notification opens the app ticket if no app window exists',async()=>{const h=worker();await h.click('./?open=my');assert.deepEqual(h.events,[['open','https://example.test/seogu-bapsang/?open=my']])});
test('existing window navigates to ticket before being focused',async()=>{const h=worker();h.self.clients.matchAll=async()=>[{url:h.self.registration.scope,focus:async()=>h.events.push('focus'),navigate:async url=>{h.events.push(['navigate',url]);return null}}];await h.click('./?open=my');assert.deepEqual(h.events,[['navigate','https://example.test/seogu-bapsang/?open=my'],'focus'])});
test('notification URLs cannot take the user outside the app',async()=>{for(const url of ['https://other.test/','https://example.test/elsewhere','javascript:alert(1)','http://[bad']){const h=worker();await h.click(url);assert.deepEqual(h.events,[['open','https://example.test/seogu-bapsang/?open=my']])}});
