/* 서구밥상 알림 서비스 워커
 * - 앱이 백그라운드 탭에 있을 때 화면 알림을 표시합니다.
 * - Firebase Cloud Function이 배포되면 앱이 닫혀 있어도 FCM 알림을 받습니다.
 */
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));

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
  messaging.onBackgroundMessage(payload=>{
    const data=payload.data||{},notification=payload.notification||{};
    return self.registration.showNotification(notification.title||data.title||"서구밥상 입장 호출",{
      body:notification.body||data.body||"지금 입장하세요.",
      icon:"./icon-192.png",
      badge:"./icon-192.png",
      tag:"seogu-entry-call",
      renotify:true,
      vibrate:[250,120,250,120,400],
      data:{url:data.url||"./?open=my"}
    });
  });
}catch(error){
  console.warn("FCM background messaging is not available in this browser.",error);
}
