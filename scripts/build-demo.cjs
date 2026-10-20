#!/usr/bin/env node
'use strict';

// Regenerate the isolated, memory-only demo from the real app's current views
// and local reservation/call logic. Every source boundary is checked; fail closed
// if a future app edit changes an expected boundary or introduces a capability.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const original = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let html = original;
function once(from, to) {
  assert.equal(html.split(from).length - 1, 1, `Unique source marker: ${from.slice(0, 90)}`);
  html = html.replace(from, to);
}
function region(start, end, replacement) {
  assert.equal(html.split(start).length - 1, 1, `Unique region start: ${start}`);
  assert.equal(html.split(end).length - 1, 1, `Unique region end: ${end}`);
  const a = html.indexOf(start), b = html.indexOf(end, a + start.length);
  assert.ok(b > a, `Ordered region: ${start}`);
  html = html.slice(0, a) + replacement + '\n' + html.slice(b);
}
function lineFunction(name, replacement) {
  const re = new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\}\\r?\\n`, 'gm');
  assert.equal([...html.matchAll(re)].length, 1, `One-line function: ${name}`);
  html = html.replace(re, replacement + '\n');
}

once('<title>서구밥상</title>', '<title>서구밥상 · 체험용</title>');
once('<meta charset="UTF-8" />', `<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; worker-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'" />`);
once('<link rel="manifest" href="./manifest.json" />\n', '');
once('<meta name="apple-mobile-web-app-capable" content="yes" />\n', '');
const externalScripts = /<script src="[^"\n]+"><\/script>\n/g;
assert.equal([...html.matchAll(externalScripts)].length, 5, 'Exactly five known external SDK scripts');
html = html.replace(externalScripts, '');
region('const firebaseConfig = {', 'const SLOTS=', '');
once('const PUSH_REGISTER_ENDPOINT = "https://asia-northeast3-seogu-bapsang.cloudfunctions.net/registerPushToken";', 'const PUSH_REGISTER_ENDPOINT = "";');
once('let firebaseOn=false;', 'const firebaseOn=false;');
once('let db=null;', 'const db=null;');
const adminHash = /^const ADMIN_CODE_SHA256="[a-f0-9]{64}";$/gm;
assert.equal([...html.matchAll(adminHash)].length, 1, 'One production admin hash');
html = html.replace(adminHash, 'const ADMIN_CODE_SHA256="demo-only-no-password";');

// No browser storage is ever touched; even accidental future saveLocal calls
// remain confined to this tab's memory and demo-only key names.
html = html.replace(/\blocalStorage\b/g, 'demoStorage').replace(/sg_real_/g, 'sg_demo_').replace(/sg_push_/g, 'sg_demo_push_');
once('<script>\n', `<script>
const demoStorage=(()=>{const values=new Map();return Object.freeze({getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key),clear:()=>values.clear()});})();
const DEMO_SESSION_DATE=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
`);
region('<div id="login" class="overlay">', '<script>', '');
region('async function init(){', 'function setModeBadge(){', 'async function init(){demoReset();}');
region('function notificationPermission(){', 'function toast(msg){', `function notificationPermission(){return "unsupported";}
function pushConnectionView(){return {label:"체험용",detail:"이 탭에서만 체험합니다."};}
async function ensureCallWorker(){return null;}
async function enablePushNotifications(){toast("체험에서는 알림을 보내지 않습니다.");}
async function setupPushMessaging(){return null;}
async function connectCallNotifications(){return null;}
async function showCallNotification(){return null;}
function notifyCall(){}`);
region('function drawQr(){', 'function listenReservations(){', 'function drawQr(){}');
region('async function startScanner(){', 'function resetLocal(){', `async function startScanner(){toast("체험에서는 카메라를 사용하지 않습니다.");}
async function scanLoop(){}
function stopScanner(){}`);
region('async function unlockAdmin(){', '// Remember only this browser', 'async function unlockAdmin(){demoRole("admin");}');
region('async function verifyAdminCode(', 'async function unlockAdmin(){', 'async function verifyAdminCode(){return true;}');
lineFunction('updateLoginState', 'function updateLoginState(){}');
lineFunction('saveLogin', 'function saveLogin(){demoRole("staff");}');
lineFunction('editUser', 'function editUser(){toast("체험직원으로 이용합니다.");}');
lineFunction('applyEditUser', 'function applyEditUser(){}');
lineFunction('logout', 'function logout(){demoReset();}');
lineFunction('closeAdmin', 'function closeAdmin(){demoRole("staff");}');
lineFunction('resetLocal', 'function resetLocal(){demoReset();}');
lineFunction('todayDate', 'function todayDate(){return DEMO_SESSION_DATE;}');
lineFunction('reservationWindowState', 'function reservationWindowState(){return "open";}');
lineFunction('reservationWindowOpen', 'function reservationWindowOpen(){return true;}');
lineFunction('reservationWindowMessage', 'function reservationWindowMessage(){return "체험은 언제든 가능합니다.";}');
region('function reservationTimePassed(', 'function operationNotice(){', 'function reservationTimePassed(){return false;}');
lineFunction('operationNotice', 'function operationNotice(){return "";}');
lineFunction('cameraPanel', 'function cameraPanel(){return `<div class="notice">체험에서는 QR·카메라를 사용하지 않습니다.</div>`;}');
region('async function checkinByCode(', 'function historyView(){', 'async function checkinByCode(){return "체험용 표는 실제 입장에 사용할 수 없습니다.";}');
lineFunction('code', 'function code(date,time,emp){return "DEMO|"+date+"|"+time+"|"+emp;}');
lineFunction('rules', 'function rules(){openModal("체험 안내",`<p>직원 예약 → 관리자 호출 → 직원 입장표 순서로 체험하세요.</p><p>이 탭에서만 동작하며, 새로고침하면 초기화됩니다.</p>`);}');

const qrDetails = /<details class="qr-details">[\s\S]*?<\/details>/g;
assert.equal([...html.matchAll(qrDetails)].length, 1, 'One ticket QR section');
html = html.replace(qrDetails, '');
once('초록색으로 바뀌면 이 화면을 보여주세요.', '호출 후 초록색으로 바뀌는 모습을 체험하세요.');
once('const CALL_OPEN_NOTICE="호출을 기다리는 동안 이 화면을 켜두세요. 화면을 닫거나 잠그면 호출 알림을 받을 수 없어요.";', 'const CALL_OPEN_NOTICE="위의 관리자 버튼으로 호출한 뒤 직원 화면을 확인하세요.";');
once('<div class="ticket-call">', '<div class="demo-watermark">체험용 · 실제 예약/입장 불가</div><div class="ticket-call">');
once('<div class="done-top">', '<div class="demo-watermark">체험용 · 실제 예약/입장 불가</div><div class="done-top">');
once('<div class="app">', `<div class="demo-toolbar" role="region" aria-label="체험 제어">
  <strong>체험용 · 실제 예약/입장 불가</strong>
  <div class="demo-controls"><button id="demo-staff" onclick="demoRole('staff')">직원</button><button id="demo-admin" onclick="demoRole('admin')">관리자</button><button onclick="demoReset()">처음부터</button></div>
  <small>이 탭에서만 체험 · 새로고침하면 초기화</small>
</div>
<div class="app">`);
once('</style>', `.demo-toolbar{position:sticky;top:0;z-index:200;max-width:430px;margin:0 auto;padding:10px 14px;background:#172554;color:#fff;text-align:center;box-sizing:border-box;box-shadow:0 3px 12px #0f172a26}
.demo-toolbar strong{display:block;font-size:14px}.demo-controls{display:flex;gap:7px;margin:8px 0 4px}.demo-controls button{flex:1;border:1px solid #94a3b8;border-radius:10px;padding:9px 4px;background:#fff;color:#172554;font-weight:900;font-size:14px;cursor:pointer}.demo-controls button[aria-pressed="true"]{background:#fb923c;color:#172554;border-color:#fb923c}.demo-toolbar small{font-size:11px;color:#cbd5e1}.top{position:static}.demo-watermark{position:relative;z-index:2;display:block;margin:0 0 12px;padding:9px 5px;border:2px dashed #9f1239;border-radius:10px;background:#fff1f2;color:#9f1239;font-weight:950;font-size:14px;letter-spacing:.02em}.entry-ticket .demo-watermark{transform:rotate(-3deg)}
</style>`);
const demoHelpers = `
// All demo interaction stays in this tab. No server, login, or device permission.
views.more=()=>st.adminUnlocked?adminView():'<div class="card"><div class="title">체험 안내</div><div class="sub">예약한 뒤 위의 관리자 버튼을 눌러 호출해보세요.</div></div>';
function demoRole(role){
  const admin=role==="admin";
  st.adminUnlocked=admin;st.date=todayDate();
  const mine=myOnDate(st.date);
  if(admin){st.tab="more";st.adminTab="call";st.adminCallSlot=mine?mine.time:st.slot;}
  else st.tab=mine?"my":"home";
  document.getElementById("demo-staff")?.setAttribute("aria-pressed",String(!admin));
  document.getElementById("demo-admin")?.setAttribute("aria-pressed",String(admin));
  render();
}
function demoReset(){
  demoStorage.clear();
  st.user={emp:"0000",name:"체험직원",orgKey:"planning",dept:"기획실"};
  st.date=todayDate();st.slot=SLOTS[0][0];st.bookingType="individual";st.partySize=2;
  st.reservations=[];st.notices=[];st.penalties={};st.queueControls={};st.showHistory=false;
  st.adminUnlocked=false;st.adminTab="call";st.adminCallSlot=SLOTS[0][0];st.adminCallSize=10;
  st.scanStream=null;st.scanTimer=null;historyRows=[];slotSummaries={};confirmedReservations=new Map();
  uiNoticeDraft=null;uiNoticeSaving=false;reserve.pending=false;reserveFirebase.pending=false;callNext.pending=false;
  dataState={reservation:"ready",slots:"ready",controls:"ready",penalty:"ready",queue:"idle",notices:"ready"};
  const modal=document.getElementById("modal");if(modal)modal.classList.remove("show");
  demoRole("staff");
}
`;
once('</script>', demoHelpers + '\n</script>');

// Hard guards keep a future build from silently acquiring production access.
for (const forbidden of [/\blocalStorage\b/, /\bsessionStorage\b/, /sg_real_/, /sg_push_/, /SGMEAL/,
  /firebaseConfig/, /firebase\.initializeApp/, /https?:\/\//, /<script\s+src=/, /rel="manifest"/,
  /serviceWorker/, /getUserMedia/, /Notification\./, /\bfetch\s*\(/]) {
  assert.equal(forbidden.test(html), false, `Demo capability forbidden: ${forbidden}`);
}
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inline.length, 1, 'Exactly one inline application script');
new vm.Script(inline[0][1], { filename: 'demo.html' });
const fingerprint = createHash('sha256').update(original).digest('hex');
html = html.replace('<!DOCTYPE html>', `<!DOCTYPE html>\n<!-- Generated by scripts/build-demo.cjs; index.html SHA-256: ${fingerprint} -->`);
fs.writeFileSync(path.join(root, 'demo.html'), html);
console.log(`Built demo.html from index.html (${fingerprint.slice(0, 12)}); isolated script syntax verified.`);
