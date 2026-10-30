const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const rawSource=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
// 운영 규칙은 시험용 종일 개방 스위치를 끈 상태(정식 운영)로 검증합니다.
const source=rawSource.replace(/const OPEN_ALL_DAY_FOR_TEST=(true|false);/,'const OPEN_ALL_DAY_FOR_TEST=false;');
function app(){
 const c={Date,Intl,crypto:webcrypto,TextEncoder,Uint8Array,console,document:{addEventListener(){},getElementById:()=>null},localStorage:{getItem:()=>null}};
 vm.createContext(c);vm.runInContext(source,c);return{c,run:s=>vm.runInContext(s,c)};
}
const at=t=>new Date(`2026-10-19T${t}+09:00`);
test('the shipped app has the all-day test switch off',()=>{assert.match(rawSource,/const OPEN_ALL_DAY_FOR_TEST=false;/);});
test('booking window is 10:00 inclusive to 11:00 exclusive in Korea',()=>{
 const {c}=app();for(const [time,open] of [['09:59:59',false],['10:00:00',true],['10:59:59',true],['11:00:00',false],['11:40:00',false]])assert.equal(c.reservationWindowOpen(at(time)),open,time);
 assert.equal(c.reservationWindowState(at('09:00:00')),'before');assert.equal(c.reservationWindowState(at('11:00:00')),'closed');
});
test('Korea calendar date is used even when UTC date is still yesterday',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(app().c.koreaClock(new Date('2026-10-18T15:00:00Z')))),{date:'2026-10-19',minutes:0});
});
test('six consecutive five minute employee sessions hold exactly 300 people',()=>{
 const {c,run}=app(),slots=JSON.parse(run('JSON.stringify(SLOTS)'));
 assert.deepEqual(slots,[['11:40',50],['11:45',50],['11:50',50],['11:55',50],['12:00',50],['12:05',50]]);
 assert.equal(slots.reduce((n,s)=>n+s[1],0),300);
 assert.deepEqual(slots.map(s=>c.slotEndTime(s[0])),['11:45','11:50','11:55','12:00','12:05','12:10']);
});
test('every department can select every session without overflow quotas or month rotation',()=>{
 const {run}=app();assert.equal(run('ORG_GROUPS.every(org=>SLOTS.every(([time])=>isEligibleTime(time,"2026-10-19",org)&&isEligibleTime(time,"2026-11-19",org)&&!isOverflowChoice(time,"2026-10-19",org)))'),true);
 assert.equal(run('isEligibleTime("12:10","2026-10-19",ORG_GROUPS[0])'),false);
});
test('late arrival starts at the end of the reserved five minute interval',()=>{
 const {c}=app(),r={date:'2026-10-19',time:'11:40'};
 assert.equal(c.reservationTimePassed(r,at('11:44:59')),false);assert.equal(c.reservationTimePassed(r,at('11:45:00')),true);
 assert.equal(c.reservationTimePassed({...r,time:'11:55'},at('11:59:59')),false);
 assert.equal(c.reservationTimePassed({...r,time:'11:55'},at('12:00:00')),true);
 assert.equal(c.reservationTimePassed({...r,time:'12:00'},at('12:04:59')),false);
 assert.equal(c.reservationTimePassed({...r,time:'12:00'},at('12:05:00')),true);
});
test('an expired called ticket loses its green entry permission; checked-in stays complete',()=>{
 const {c,run}=app();run('firebaseOn=false;reservationTimePassed=()=>true');
 assert.equal(c.callVisual({status:'reserved',time:'11:40',callStatus:'called'}).short,'예약시간 지남');
 assert.equal(c.callVisual({status:'checkedin',time:'11:40',callStatus:'called'}).short,'입장 완료');
});
test('clock refreshes the open screen only on minute changes and does not disrupt settings forms',()=>{
 const {run}=app();run('let renders=0;render=()=>renders++;koreaClock=()=>({date:"2026-10-19",minutes:659});st.tab="home";updateOperationClock();updateOperationClock()');assert.equal(run('renders'),1);
 run('koreaClock=()=>({date:"2026-10-19",minutes:660});updateOperationClock()');assert.equal(run('renders'),2);
 run('st.tab="more";koreaClock=()=>({date:"2026-10-19",minutes:661});updateOperationClock()');assert.equal(run('renders'),2);
});
test('home keeps booking hours brief while the guide retains operational details',()=>{
 const {c,run}=app();let guide='';c.openModal=(title,body)=>guide=body;c.rules();
 assert.ok(c.operationNotice().includes('예약 가능시간'));assert.ok(c.operationNotice().includes('10:00~11:00'));
 assert.ok(guide.includes('12:10 이후'));
 assert.ok(guide.includes('현업근로자'));assert.ok(!guide.includes('공무직'));
 assert.ok(guide.includes('11:30~11:40'));
 assert.equal(guide.includes('150명'),false);
 assert.equal(c.operationNotice().includes('현업근로자'),false);
 assert.ok(guide.includes('총 300명'));assert.equal(run('SLOTS.length'),6);assert.ok(guide.includes('10:00~11:00'));assert.equal(/QR/.test(guide),false);
});
test('admin verification rejects the old demo code and handles configured SHA-256 correctly',async()=>{
 const {c}=app();assert.equal(await c.verifyAdminCode('1234'),false);assert.equal(await c.verifyAdminCode(''),false);
 const configured=html.match(/const ADMIN_CODE_SHA256="([a-f0-9]+)"/)[1];
 c.crypto={subtle:{digest:async()=>Buffer.from(configured,'hex')}};
 assert.equal(await c.verifyAdminCode('test-only-input'),true);
});
test('an expired QR cannot bypass the late-arrival notice; manual attendance remains available',()=>{
 const {c,run}=app();run('todayDate=()=>"2026-10-19";reservationTimePassed=()=>true');
 const r={date:'2026-10-19',status:'reserved',qrEligible:true,code:'test-qr',callStatus:'called'};
 assert.ok(c.checkinValidationMessage(r,'test-qr').includes('12:10'));
 assert.equal(c.checkinValidationMessage(r), '');
});

test('pre-pilot test switch opens booking all day and never expires tickets',()=>{
 const c={Date,Intl,crypto:webcrypto,TextEncoder,Uint8Array,console,document:{addEventListener(){},getElementById:()=>null},localStorage:{getItem:()=>null}};
 vm.createContext(c);vm.runInContext(rawSource.replace(/const OPEN_ALL_DAY_FOR_TEST=(true|false);/,'const OPEN_ALL_DAY_FOR_TEST=true;'),c);
 for(const t of ['07:00:00','10:30:00','17:49:00'])assert.equal(c.reservationWindowOpen(at(t)),true,t);
 assert.equal(c.reservationTimePassed({date:'2026-10-19',time:'11:40'},at('17:00:00')),false);
});

test('admin schedule changes apply from the next day and validate times and caps',()=>{
 const {c,run}=app();
 assert.equal(c.cleanSlots([{time:'11:40',cap:50},{time:'11:40',cap:30}]),null);
 assert.equal(c.cleanSlots([{time:'09:30',cap:50}]),null);
 assert.equal(c.cleanSlots([{time:'11:40',cap:0}]),null);
 assert.deepEqual(JSON.parse(JSON.stringify(c.cleanSlots([{time:'12:00',cap:70},{time:'11:40',cap:60}]))),[['11:40',60],['12:00',70]]);
 const versions=[{from:'2026-10-31',slots:[{time:'11:40',cap:70},{time:'11:50',cap:70}]}];
 assert.equal(JSON.stringify(c.slotsForDate('2026-10-30',versions)),JSON.stringify(c.slotsForDate('2026-10-30',[])));
 assert.equal(JSON.stringify(c.slotsForDate('2026-10-31',versions)),JSON.stringify([['11:40',70],['11:50',70]]));
 run(`SLOTS.splice(0,SLOTS.length,['11:40',70],['11:50',70])`);
 assert.equal(c.slotEndTime('11:40'),'11:50');assert.equal(c.slotEndTime('11:50'),'12:00');
});
