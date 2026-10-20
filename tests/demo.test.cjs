const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = () => fs.readFileSync(path.join(__dirname, '../demo.html'), 'utf8');
function app() {
  const touched = [];
  const forbidden = name => { touched.push(name); throw new Error('Demo touched ' + name); };
  const node = () => ({innerHTML:'',textContent:'',value:'',classList:{add(){},remove(){},toggle(){}},setAttribute(){}});
  const nodes = new Map();
  const context = {
    Date, Intl, URLSearchParams, console,
    document:{addEventListener(){},getElementById(id){if(!nodes.has(id))nodes.set(id,node());return nodes.get(id)},querySelectorAll(){return []}},
    window:{addEventListener(){},scrollTo(){},setTimeout(){return 1}},
    location:{search:'',reload(){forbidden('reload')}},
    navigator:{onLine:true,get serviceWorker(){return forbidden('service worker')},get mediaDevices(){return forbidden('camera')}},
    setInterval(){return 1},clearInterval(){},setTimeout(){return 1},clearTimeout(){},
    get localStorage(){return forbidden('production localStorage')},
    get firebase(){return forbidden('Firebase')},
    fetch(){return forbidden('network')},
    get Notification(){return forbidden('notifications')},
    confirm:()=>true,
  };
  vm.createContext(context);
  const source = [...html().matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
  vm.runInContext(source, context);
  vm.runInContext('render=()=>{};updateLoginState=()=>{};populateOrganizationSelect=()=>{};populateDeptSelect=()=>{};toast=()=>{};',context);
  return {context,touched,run:code=>vm.runInContext(code,context)};
}

test('demo loads with no external SDK, installation manifest, or live connection permission',()=>{
  const content=html();
  assert.doesNotMatch(content,/<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(content,/<link\b[^>]*\brel=["']manifest["']/i);
  assert.match(content,/connect-src 'none'/);
  assert.match(content,/체험용/);
  assert.match(content,/실제 예약\/입장 불가/);
});

test('initialization, group booking and calling work without touching production services or storage',async()=>{
  const h=app();
  await h.context.init();
  assert.equal(h.run('firebaseOn'),false);
  assert.equal(h.run('firebaseInitFailed'),false);
  assert.ok(h.run('st.user && userOrganization()'));
  // Keep the real booking and calling code; only suppress DOM rendering in this VM.
  h.run('st.reservations=[];st.queueControls={};st.penalties={};st.bookingType="group";st.partySize=3;st.slot="11:40";st.date=todayDate();');
  await h.context.reserve();
  assert.equal(h.run('st.reservations.length'),1);
  assert.equal(h.run('latest().partySize'),3);
  assert.equal(h.run('counts(todayDate())["11:40"]'),3);
  assert.equal(h.run('callVisual(latest()).short'),'대기 중');
  assert.doesNotMatch(h.run('latest().code'),/^SGMEAL\|/);
  h.run('st.adminUnlocked=true;st.tab="more";st.adminCallSlot="11:40"');
  await h.context.callNext(3);
  assert.equal(h.run('latest().callStatus'),'called');
  assert.equal(h.run('callVisual(latest()).theme.accent'),'#16a34a');
  assert.equal(h.run('counts(todayDate())["11:40"]'),3);
  assert.match(h.run('views.my()'),/체험용/);
  assert.match(h.run('views.my()'),/실제.*입장 불가/);
  assert.deepEqual(h.touched,[]);
});

test('demo can be used outside booking hours and after the meal slot expires',()=>{
  const h=app();
  for(const time of ['09:00','10:30','11:00','17:00']) {
    const now=new Date('2026-10-20T'+time+':00+09:00');
    assert.equal(h.context.reservationWindowOpen(now),true,time);
    assert.equal(h.context.reservationTimePassed({date:'2026-10-20',time:'11:40'},now),false,time);
  }
});
