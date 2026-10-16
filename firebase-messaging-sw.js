/* 서구밥상 알림 서비스 워커
 * 서버가 보낸 호출을 화면을 잠그거나 앱 화면을 닫은 상태에서도 표시합니다.
 * 기기의 알림 허용과 인터넷 연결이 필요합니다.
 */
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
const pendingCallKeys=new Set(),displayedCallKeys=new Set();

function currentCallPayload(data){
  // During rollout, an older sender may omit expiry. A supplied expiry must be valid.
  if(!Object.prototype.hasOwnProperty.call(data,"expiresAt"))return true;
  if(typeof data.expiresAt!=="number"&&(typeof data.expiresAt!=="string"||!/^\d+$/.test(data.expiresAt)))return false;
  const expiry=Number(data.expiresAt);
  return Number.isSafeInteger(expiry)&&expiry>Date.now();
}

async function displayBackgroundCall(payload){
  // FCM displays notification payloads itself. Our server sends data-only calls.
  if(!payload||payload.notification)return;
  const data=payload.data||{};
  if(!currentCallPayload(data))return;
  const callKey=typeof data.reservationId==="string"&&data.reservationId&&typeof data.callBatchId==="string"&&data.callBatchId?`${data.reservationId}:${data.callBatchId}`:"";
  if(callKey&&(pendingCallKeys.has(callKey)||displayedCallKeys.has(callKey)))return;
  if(callKey)pendingCallKeys.add(callKey);
  try{
    if(callKey&&typeof self.registration.getNotifications==="function"){
      try{
        const visible=await self.registration.getNotifications({tag:"seogu-entry-call"});
        if(visible.some(notification=>notification.data?.callKey===callKey))return;
      }catch(error){/* A notification-list failure must not hide a new call. */}
    }
    // The notification lookup can yield; don't display a call that expired meanwhile.
    if(!currentCallPayload(data))return;
    await self.registration.showNotification(data.title||"서구밥상 입장 호출",{
      body:data.body||"지금 입장하세요.",
      icon:"./icon-192.png",
      badge:"./icon-192.png",
      tag:"seogu-entry-call",
      renotify:true,
      vibrate:[250,120,250,120,400],
      data:{url:data.url||"./?open=my",callKey}
    });
    if(callKey){
      displayedCallKeys.add(callKey);
      if(displayedCallKeys.size>100)displayedCallKeys.delete(displayedCallKeys.values().next().value);
    }
  }finally{
    if(callKey)pendingCallKeys.delete(callKey);
  }
}

// Register before Firebase so tapping a call always opens this app's ticket.
self.addEventListener("notificationclick",event=>{
  if(event.notification.tag!=="seogu-entry-call")return;
  event.stopImmediatePropagation();
  event.notification.close();
  const fallback=new URL("./?open=my",self.registration.scope);
  let target=fallback;
  try{
    const candidate=new URL(event.notification.data?.url||fallback.href,self.registration.scope);
    if(candidate.origin===fallback.origin&&candidate.pathname.startsWith(new URL(self.registration.scope).pathname))target=candidate;
  }catch(error){/* Use the app ticket for a malformed notification URL. */}
  event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    for(const client of clients){
      if(client.url.startsWith(self.registration.scope)&&"focus" in client){
        const navigated=await client.navigate(target.href);
        return (navigated||client).focus();
      }
    }
    return self.clients.openWindow?self.clients.openWindow(target.href):undefined;
  })());
});

try{
  importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js");
  importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js");
  firebase.initializeApp({
    apiKey:"AIzaSyCVqWRnBMtQFUU51xzukqVEnFts-VqEnhA",
    authDomain:"seogu-bapsang.firebaseapp.com",
    projectId:"seogu-bapsang",
    storageBucket:"seogu-bapsang.firebasestorage.app",
    messagingSenderId:"335336990084",
    appId:"1:335336990084:web:899e3f4d3532ac4e2329d1"
  });
  const messaging=firebase.messaging();
  messaging.onBackgroundMessage(displayBackgroundCall);
}catch(error){
  console.warn("FCM background messaging is not available in this browser.",error);
}
