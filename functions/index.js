const {createHash}=require("node:crypto");
const {onDocumentUpdated}=require("firebase-functions/v2/firestore");
const {onRequest}=require("firebase-functions/v2/https");
const {defineString}=require("firebase-functions/params");
const {initializeApp}=require("firebase-admin/app");
const {getFirestore}=require("firebase-admin/firestore");
const {getMessaging}=require("firebase-admin/messaging");

initializeApp();

const WEB_PUSH_VAPID_KEY=defineString("WEB_PUSH_VAPID_KEY",{default:""});
const HTTP_OPTIONS={region:"asia-northeast3",cors:["https://hkejys9654-tech.github.io"]};
const APP_URL="https://hkejys9654-tech.github.io/seogu-bapsang/?open=my";
const CALL_LIFETIME_MS=120000;
const INVALID_TOKEN_CODES=new Set(["messaging/registration-token-not-registered","messaging/invalid-registration-token"]);
const tokenId=token=>createHash("sha256").update(token).digest("hex");
const todayKST=now=>new Date(now+9*60*60*1000).toISOString().slice(0,10);

function deviceInput(request){
  const {token,emp}=request.body||{};
  if(typeof token!=="string"||!token.trim()||token.length>4096||!/^\d{4}$/.test(String(emp||"")))return null;
  return{token,emp:String(emp)};
}

function timestampMillis(value){
  if(value&&typeof value.toMillis==="function")return value.toMillis();
  if(value instanceof Date)return value.getTime();
  return typeof value==="number"?value:NaN;
}

function deliveredCallKeys(device){
  const keys=Array.isArray(device.sentCallKeys)?device.sentCallKeys.filter(key=>typeof key==="string"):[];
  if(typeof device.lastCallKey==="string")keys.push(device.lastCallKey);
  return [...new Set(keys)].slice(-8);
}

// This is a PUBLIC browser key, not a service account key or a private VAPID key.
exports.getPushConfig=onRequest(HTTP_OPTIONS,(request,response)=>{
  if(request.method!=="GET")return response.status(405).json({error:"method_not_allowed"});
  const vapidKey=WEB_PUSH_VAPID_KEY.value().trim();
  response.set("Cache-Control","no-store");
  return response.json({enabled:Boolean(vapidKey),vapidKey});
});

// Demo employee identification is intentionally unchanged. Never accept a browser
// supplied recipient list or send request; the Firestore call event owns sending.
exports.registerPushToken=onRequest(HTTP_OPTIONS,async (request,response)=>{
  if(request.method!=="POST")return response.status(405).json({error:"method_not_allowed"});
  const device=deviceInput(request);
  if(!device)return response.status(400).json({error:"invalid_request"});
  try{
    const ref=getFirestore().collection("pushTokens").doc(tokenId(device.token));
    await getFirestore().runTransaction(async tx=>{
      const doc=await tx.get(ref),previous=doc.exists?doc.data():null;
      const next={...device,enabled:true,updatedAt:new Date()};
      if(previous&&previous.token===device.token&&String(previous.emp)===device.emp){
        next.sentCallKeys=deliveredCallKeys(previous);
        if(previous.lastSentAt)next.lastSentAt=previous.lastSentAt;
      }
      // Replace the document to drop old name/department fields while retaining
      // this employee's delivery history across normal page reconnects.
      tx.set(ref,next);
    });
    return response.json({ok:true});
  }catch(error){
    console.error("Push device registration failed",error.code||"unknown");
    return response.status(503).json({error:"registration_failed"});
  }
});

exports.unregisterPushToken=onRequest(HTTP_OPTIONS,async (request,response)=>{
  if(request.method!=="POST")return response.status(405).json({error:"method_not_allowed"});
  const device=deviceInput(request);
  if(!device)return response.status(400).json({error:"invalid_request"});
  try{
    const collection=getFirestore().collection("pushTokens");
    const refs=[collection.doc(tokenId(device.token)),collection.doc(device.emp)];
    await getFirestore().runTransaction(async tx=>{
      const docs=await Promise.all(refs.map(ref=>tx.get(ref)));
      docs.forEach(doc=>{
        const data=doc.exists?doc.data():null;
        if(data&&data.token===device.token&&String(data.emp)===device.emp){
          tx.update(doc.ref,{enabled:false,updatedAt:new Date()});
        }
      });
    });
    return response.json({ok:true});
  }catch(error){
    console.error("Push device removal failed",error.code||"unknown");
    return response.status(503).json({error:"unregistration_failed"});
  }
});

async function updateDeviceIfCurrent(ref,device,changes){
  await getFirestore().runTransaction(async tx=>{
    const doc=await tx.get(ref);
    const current=doc.exists?doc.data():null;
    if(current&&current.token===device.token&&String(current.emp)===String(device.emp))tx.update(ref,changes);
  });
}

async function recordDeliveredCall(ref,device,callKey){
  await getFirestore().runTransaction(async tx=>{
    const doc=await tx.get(ref),current=doc.exists?doc.data():null;
    if(current&&current.token===device.token&&String(current.emp)===String(device.emp)){
      const keys=deliveredCallKeys(current).filter(key=>key!==callKey);
      tx.update(ref,{sentCallKeys:[...keys,callKey].slice(-8),lastCallKey:callKey,lastSentAt:new Date()});
    }
  });
}

async function activeDevices(emp,callKey){
  const collection=getFirestore().collection("pushTokens");
  const snapshot=await collection.where("emp","==",emp).get();
  const devices=new Map();
  for(const doc of snapshot.docs){
    const data=doc.data();
    if(data.enabled===false||typeof data.token!=="string"||!data.token)continue;
    let current={ref:doc.ref,data};
    // Old versions saved one token per employee. A canonical device record takes
    // precedence, including a disabled record or a device now used by another employee.
    if(doc.id!==tokenId(data.token)){
      const canonical=await collection.doc(tokenId(data.token)).get();
      if(canonical.exists)current={ref:canonical.ref,data:canonical.data()};
    }
    if(current.data.enabled===false||String(current.data.emp)!==emp||deliveredCallKeys(current.data).includes(callKey))continue;
    devices.set(current.data.token,current);
  }
  return[...devices.values()];
}

exports.notifyEntryCall=onDocumentUpdated({document:"reservations/{reservationId}",region:"asia-northeast3",retry:true},async event=>{
  if(!event.data)return;
  const before=event.data.before.data();
  const after=event.data.after.data();
  if(!after||after.callStatus!=="called"||after.status!=="reserved"||!/^\d{4}$/.test(String(after.emp||""))||!after.callBatchId)return;
  if(before&&before.callStatus==="called"&&before.callBatchId===after.callBatchId)return;

  const now=Date.now();
  const calledAt=timestampMillis(after.calledAt);
  // Missing/expired timestamps must not deliver an old call on a later retry.
  if(!Number.isFinite(calledAt)||calledAt>now+30000||calledAt+CALL_LIFETIME_MS<=now||after.date!==todayKST(now))return;
  const reservationId=event.params.reservationId;
  const latestDoc=await getFirestore().collection("reservations").doc(reservationId).get();
  const latest=latestDoc.exists?latestDoc.data():null;
  if(!latest||latest.status!=="reserved"||latest.callStatus!=="called"||latest.date!==after.date||String(latest.emp)!==String(after.emp)||latest.callBatchId!==after.callBatchId)return;

  const callKey=`${reservationId}:${after.callBatchId}`;
  const devices=await activeDevices(String(after.emp),callKey);
  if(!devices.length)return;
  const expiresAt=calledAt+CALL_LIFETIME_MS;
  const queue=String(latest.queueNumber||"").padStart(3,"0");
  let transientFailure=false;
  for(let offset=0;offset<devices.length;offset+=500){
    const ttl=Math.floor((expiresAt-Date.now())/1000);
    if(ttl<=0)return;
    const batch=devices.slice(offset,offset+500);
    const result=await getMessaging().sendEachForMulticast({
      tokens:batch.map(device=>device.data.token),
      // Data only: the service worker owns display, expiry and duplicate handling.
      data:{title:"🍚 지금 입장하세요",body:`${latest.time} · 대기번호 ${queue}번 · ${latest.callToken||"초록 입장표를 확인하세요"}`,
        url:APP_URL,emp:String(after.emp),reservationId,callBatchId:String(after.callBatchId),expiresAt:String(expiresAt)},
      webpush:{headers:{Urgency:"high",TTL:String(Math.min(120,ttl)),Topic:tokenId(callKey).slice(0,32)}}
    });
    await Promise.all(result.responses.map(async (sent,index)=>{
      const device=batch[index];
      if(sent.success){
        await recordDeliveredCall(device.ref,device.data,callKey);
      }else if(INVALID_TOKEN_CODES.has(sent.error&&sent.error.code)){
        await updateDeviceIfCurrent(device.ref,device.data,{enabled:false,updatedAt:new Date()});
      }else{
        transientFailure=true;
        console.warn("Entry push will retry",sent.error&&sent.error.code||"unknown");
      }
    }));
  }
  // Keep valid devices enabled on quota, permission, transport or service errors.
  // Retry processing rechecks date, state and expiry, and skips successful devices.
  if(transientFailure)throw new Error("PUSH_DELIVERY_RETRY");
});
