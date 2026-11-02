// 서구밥상 호출 알림 서버 (Blaze 요금제)
// 비용 안전장치: 서버는 최대 2대·256MB만 쓰고, 호출 상태가 "called"로 바뀔 때 한 번만 알림을 보냅니다.
const {setGlobalOptions}=require("firebase-functions/v2");
const {onDocumentUpdated}=require("firebase-functions/v2/firestore");
const {onRequest}=require("firebase-functions/v2/https");
const {initializeApp}=require("firebase-admin/app");
const {getFirestore}=require("firebase-admin/firestore");
const {getMessaging}=require("firebase-admin/messaging");

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
