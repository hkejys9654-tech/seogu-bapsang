const {onDocumentUpdated}=require("firebase-functions/v2/firestore");
const {onRequest}=require("firebase-functions/v2/https");
const {initializeApp}=require("firebase-admin/app");
const {getFirestore}=require("firebase-admin/firestore");
const {getMessaging}=require("firebase-admin/messaging");

initializeApp();

exports.registerPushToken=onRequest({region:"asia-northeast3",cors:["https://hkejys9654-tech.github.io"]},async (request,response)=>{
  if(request.method!=="POST")return response.status(405).json({error:"method_not_allowed"});
  const {token,emp,name,orgKey,dept}=request.body||{};
  if(!token||!/^[0-9]{4}$/.test(String(emp||"")))return response.status(400).json({error:"invalid_request"});
  await getFirestore().collection("pushTokens").doc(String(emp)).set({token,emp:String(emp),name:String(name||""),orgKey:String(orgKey||""),dept:String(dept||""),enabled:true,updatedAt:new Date()},{merge:true});
  return response.json({ok:true});
});

exports.notifyEntryCall=onDocumentUpdated({document:"reservations/{reservationId}",region:"asia-northeast3"},async event=>{
  if(!event.data)return;
  const before=event.data.before.data();
  const after=event.data.after.data();
  if(before.callStatus==="called"||after.callStatus!=="called"||!after.emp)return;

  const tokenDoc=await getFirestore().collection("pushTokens").doc(String(after.emp)).get();
  if(!tokenDoc.exists||tokenDoc.data().enabled===false||!tokenDoc.data().token)return;

  const queue=String(after.queueNumber||"").padStart(3,"0");
  await getMessaging().send({
    token:tokenDoc.data().token,
    data:{
      title:"🍚 지금 입장하세요",
      body:`${after.time} · 대기번호 ${queue}번 · ${after.callToken||"초록 입장표를 확인하세요"}`,
      url:"https://hkejys9654-tech.github.io/seogu-bapsang/?open=my",
      reservationId:event.params.reservationId
    },
    webpush:{
      headers:{Urgency:"high"},
      fcmOptions:{link:"https://hkejys9654-tech.github.io/seogu-bapsang/?open=my"}
    }
  });
});
