// 서구밥상 호출 알림 서버 (Blaze 요금제)
// 비용 안전장치: 서버는 최대 2대·256MB만 쓰고, 호출 상태가 "called"로 바뀔 때 한 번만 알림을 보냅니다.
const {setGlobalOptions}=require("firebase-functions/v2");
const {onDocumentUpdated}=require("firebase-functions/v2/firestore");
const {onRequest}=require("firebase-functions/v2/https");
const {initializeApp}=require("firebase-admin/app");
const {getFirestore}=require("firebase-admin/firestore");
const {getMessaging}=require("firebase-admin/messaging");
const {getAuth}=require("firebase-admin/auth");
const {defineSecret}=require("firebase-functions/params");
const crypto=require("crypto");

initializeApp();
setGlobalOptions({region:"asia-northeast3",maxInstances:2,memory:"256MiB",timeoutSeconds:30});

const APP_URL="https://hkejys9654-tech.github.io/seogu-bapsang/?open=my";

exports.registerPushToken=onRequest({cors:["https://hkejys9654-tech.github.io"]},async (request,response)=>{
  if(request.method!=="POST")return response.status(405).json({error:"method_not_allowed"});
  const {token,emp,name,orgKey,dept}=request.body||{};
  if(typeof token!=="string"||token.length<20||token.length>4096||!/^[0-9]{4}$/.test(String(emp||"")))return response.status(400).json({error:"invalid_request"});
  const clip=v=>String(v||"").slice(0,40);
  await getFirestore().collection("pushTokens").doc(String(emp)).set({token,emp:String(emp),name:clip(name),orgKey:clip(orgKey),dept:clip(dept),enabled:true,updatedAt:new Date()},{merge:true});
  return response.json({ok:true});
});

// 대표자와 함께 가는 직원(동행)에게 모두 알림을 보냅니다.
exports.notifyEntryCall=onDocumentUpdated("reservations/{reservationId}",async event=>{
  if(!event.data)return;
  const before=event.data.before.data(),after=event.data.after.data();
  if(!after||after.callStatus!=="called"||!after.emp)return;
  if(before&&before.callStatus==="called"&&before.callBatchId===after.callBatchId)return;

  const emps=[...new Set([after.emp,...(Array.isArray(after.members)?after.members.map(m=>m&&m.emp):[])].filter(e=>/^[0-9]{4}$/.test(String(e||""))).map(String))].slice(0,10);
  const db=getFirestore(),queue=String(after.queueNumber||"").padStart(3,"0");
  const docs=await Promise.all(emps.map(e=>db.collection("pushTokens").doc(e).get()));
  await Promise.all(docs.filter(d=>d.exists&&d.data().enabled!==false&&d.data().token).map(async d=>{
    try{
      await getMessaging().send({
        token:d.data().token,
        data:{title:"🍚 지금 입장하세요",body:`${after.time} · 대기번호 ${queue}번 · ${after.callToken||"초록 입장표를 확인하세요"}`,url:APP_URL,reservationId:event.params.reservationId},
        webpush:{headers:{Urgency:"high",TTL:"600"},fcmOptions:{link:APP_URL}}
      });
    }catch(err){
      // 앱을 지웠거나 알림을 끈 휴대폰은 다음부터 보내지 않습니다.
      if(/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(String(err&&err.code)))await d.ref.set({enabled:false,updatedAt:new Date()},{merge:true});
      else console.error(err);
    }
  }));
});

// 관리자 로그인: 번호는 서버 비밀값(ADMIN_CODE)에만 있고 앱에는 없습니다.
// 맞으면 그 기기의 로그인에 12시간짜리 관리자 표시를 붙이고, Firestore 규칙이 이 표시를 확인합니다.
// 같은 곳에서 5번 틀리면 15분, 전체에서 한 시간에 30번 틀리면 15분 동안 잠급니다.
const ADMIN_CODE=defineSecret("ADMIN_CODE");
const ADMIN_HOURS=12,MAX_FAILS=5,GLOBAL_FAILS=30,LOCK_MS=15*60*1000,WINDOW_MS=60*60*1000;
const sha=v=>crypto.createHash("sha256").update(String(v)).digest();
exports.adminLogin=onRequest({cors:["https://hkejys9654-tech.github.io"],secrets:[ADMIN_CODE]},async (request,response)=>{
  if(request.method!=="POST")return response.status(405).json({error:"method_not_allowed"});
  const {code,idToken}=request.body||{};
  if(typeof code!=="string"||!code||code.length>64||typeof idToken!=="string")return response.status(400).json({error:"invalid_request"});
  let uid;
  try{uid=(await getAuth().verifyIdToken(idToken)).uid;}catch(err){return response.status(401).json({error:"invalid_token"});}
  const db=getFirestore(),now=Date.now();
  const ip=String(request.headers["x-forwarded-for"]||request.ip||"unknown").split(",")[0].trim();
  const refs=[db.collection("adminAttempts").doc("ip_"+sha(ip).toString("hex").slice(0,32)),db.collection("adminAttempts").doc("all")];
  const states=(await Promise.all(refs.map(r=>r.get()))).map(s=>s.exists?s.data():{});
  const lock=Math.max(...states.map(d=>Number(d.lockUntil||0)));
  if(lock>now)return response.status(429).json({error:"locked",minutes:Math.ceil((lock-now)/60000)});
  const ok=crypto.timingSafeEqual(sha(code),sha(ADMIN_CODE.value()));
  if(!ok){
    await db.runTransaction(async tx=>{
      const cur=(await Promise.all(refs.map(r=>tx.get(r)))).map(s=>s.exists?s.data():{});
      cur.forEach((d,i)=>{
        const fresh=now-Number(d.windowStart||0)>WINDOW_MS,fails=(fresh?0:Number(d.fails||0))+1,limit=i===0?MAX_FAILS:GLOBAL_FAILS;
        tx.set(refs[i],fails>=limit?{fails:0,windowStart:now,lockUntil:now+LOCK_MS}:{fails,windowStart:fresh?now:Number(d.windowStart),lockUntil:0});
      });
    });
    return response.status(403).json({error:"wrong_code"});
  }
  await refs[0].set({fails:0,windowStart:now,lockUntil:0});
  const expiresAt=now+ADMIN_HOURS*60*60*1000;
  await getAuth().setCustomUserClaims(uid,{admin:true,adminExp:expiresAt});
  return response.json({ok:true,expiresAt});
});

// 자동 호출: 평일 11~12시 매분 실행. 타임이 시작되면 그 타임 예약자 전원을 '호출'로 바꾸고(→ notifyEntryCall이 알림 발송),
// 타임 동안 새로 들어온 대기자(재대기 등)도 이어서 부릅니다. 관리자가 '마감'한 타임은 건너뜁니다.
const {onSchedule}=require("firebase-functions/v2/scheduler");
const DEFAULT_SLOTS=[["11:40",40],["11:45",40],["11:50",40],["11:55",40],["12:00",40],["12:05",40]];
const WORDS=["솔잎","한결","새봄","느티","푸른","이음","바른","마루","온빛","다온"];
const toMin=t=>{const [h,m]=String(t).split(":").map(Number);return h*60+m;};
function koreaNow(){const d=new Date(Date.now()+9*3600*1000);return {date:d.toISOString().slice(0,10),min:d.getUTCHours()*60+d.getUTCMinutes()};}
function slotsFor(date,versions){
  let pick=null;for(const v of versions||[])if(v&&typeof v.from==="string"&&v.from<=date&&(!pick||v.from>pick.from))pick=v;
  const list=pick&&Array.isArray(pick.slots)?pick.slots.map(s=>[String(s.time),Number(s.cap)]).filter(s=>/^\d{2}:\d{2}$/.test(s[0])):[];
  return (list.length?list:DEFAULT_SLOTS).sort((a,b)=>a[0].localeCompare(b[0]));
}
function slotEnd(slots,i){const start=toMin(slots[i][0]);if(i<slots.length-1)return toMin(slots[i+1][0]);return start+(i>0?start-toMin(slots[i-1][0]):5);}
exports.autoCallSlots=onSchedule({schedule:"* 11-12 * * 1-5",timeZone:"Asia/Seoul",retryCount:0,maxInstances:1},async()=>{
  const db=getFirestore(),{date,min}=koreaNow();
  // 2026-11-25 한꺼번에 몰리는 문제로 중단. config/autoCall 문서의 enabled가 true일 때만 동작(스케줄러도 일시중지해 둠).
  const sw=await db.collection("config").doc("autoCall").get();
  if(!sw.exists||sw.data().enabled!==true)return;
  const cfg=await db.collection("config").doc("slotSchedule").get();
  const slots=slotsFor(date,cfg.exists?cfg.data().versions:[]);
  for(let i=0;i<slots.length;i++){
    const time=slots[i][0];
    if(min<toMin(time)||min>=slotEnd(slots,i))continue;
    const key=date+"_"+time.replace(":",""),controlRef=db.collection("queueControls").doc(key),slotRef=db.collection("slotCounts").doc(key);
    const query=db.collection("reservations").where("date","==",date).where("time","==",time).where("status","==","reserved");
    await db.runTransaction(async tx=>{
      const [control,ledgerSnap,rows]=await Promise.all([tx.get(controlRef),tx.get(slotRef),tx.get(query)]);
      if(control.exists&&control.data().closed===true)return;
      const waiting=rows.docs.filter(d=>{const r=d.data();return r.qrEligible!==false&&r.callStatus!=="called";});
      if(!waiting.length)return;
      const now=new Date(),token="초록 · "+WORDS[Math.floor(Math.random()*WORDS.length)],batchId=key+"_auto_"+now.getTime();
      const entries={};
      for(const d of waiting){
        const r=d.data();
        tx.update(d.ref,{callStatus:"called",callToken:token,callBatchId:batchId,calledAt:now,autoCalled:true,updatedAt:now});
        const q=Number(r.queueNumber);if(Number.isInteger(q)&&q>0)entries[String(q)]={size:Math.max(1,Math.min(10,Math.trunc(Number(r.partySize)||1))),waiting:false};
      }
      if(Object.keys(entries).length&&ledgerSnap.exists)tx.set(slotRef,{queueEntries:entries,updatedAt:now},{merge:true});
      tx.set(controlRef,{date,time,callRevision:Number(control.exists&&control.data().callRevision||0)+1,autoCalledAt:now,updatedAt:now},{merge:true});
    });
  }
});
