const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const source = html.slice(html.indexOf('function notificationPermission()'), html.indexOf('function toast('));
const logoutSource = html.match(/^function logout\(\).*$/m)?.[0];
const VAPID = 'B'.repeat(87);
const ENDPOINTS = {config: 'https://example.test/getPushConfig', register: 'https://example.test/registerPushToken', unregister: 'https://example.test/unregisterPushToken'};
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no}); return {promise, resolve, reject}; }
function setup(options = {}) {
  const notices = [], requests = [], toasts = [], events = [], modals = [], tokenCalls = [], deletes = [];
  const stored = new Map([['sg_push_enabled', '1']]);
  if (options.saved) stored.set('sg_push_device', JSON.stringify(options.saved));
  if (options.optedOut) stored.set('sg_push_opted_out', '1');
  const registration = {
    active: {state: 'activated'},
    async showNotification(...args) {
      if (options.displayFailure) throw Error('display failed');
      notices.push(args);
    },
  };
  const client = {
    async getToken(args) {
      events.push('getToken'); tokenCalls.push(args);
      if (options.tokenHandler) return options.tokenHandler(args);
      return options.token === undefined ? 'token-for-device' : options.token;
    },
    async deleteToken() {
      events.push('deleteToken'); deletes.push(true);
      if (options.deleteFailure) throw Error('delete failed');
      return options.deleteResult !== false;
    },
    onMessage(callback) {client.foreground = callback;},
  };
  const messaging = () => client;
  messaging.isSupported = async () => options.supported !== false;
  const context = {
    console: {warn() {}}, Promise, setTimeout, clearTimeout, AbortController,
    st: {user: options.user === false ? null : {emp: '1234', name: '테스트', dept: '기획실'}},
    firebaseOn: options.firebaseOn !== false, firebase: {messaging},
    PUSH_VAPID_KEY: options.inline ? VAPID : '',
    PUSH_REGISTER_ENDPOINT: ENDPOINTS.register,
    PUSH_CONFIG_ENDPOINT: ENDPOINTS.config,
    PUSH_UNREGISTER_ENDPOINT: ENDPOINTS.unregister,
    Notification: {
      permission: options.permission || 'granted',
      async requestPermission() {
        events.push('permission');
        context.Notification.permission = options.requestResult || 'granted';
        return context.Notification.permission;
      },
    },
    navigator: {
      userAgent: options.ios ? 'iPhone Safari' : 'Android Chrome',
      standalone: !!options.standalone,
      serviceWorker: {
        async register() {
          events.push('worker');
          if (options.workerFail) throw Error('worker failed');
          if (options.workerGate) await options.workerGate.promise;
          return registration;
        },
      },
      vibrate() {},
    },
    document: {visibilityState: 'visible'}, matchMedia: () => ({matches: !!options.standalone}),
    localStorage: {getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key)},
    render() {}, toast: message => toasts.push(message), openModal: (...args) => modals.push(args),
    todayDate: () => '2026-10-16', docId: (date, emp) => `${date}_${emp}`, queueNumberFor: r => r.queueNumber,
    populateOrganizationSelect() {}, populateDeptSelect() {}, updateLoginState() {},
    fetch: async (url, request) => {
      events.push(url); requests.push({url, request});
      if (options.fetchHandler) return options.fetchHandler(url, request);
      const type = Object.keys(ENDPOINTS).find(key => ENDPOINTS[key] === url);
      if (options.failEndpoint === type) throw Error('network failure');
      return {
        ok: options.httpFailure !== type,
        async json() {
          if (options.invalidJSON === type) throw Error('invalid JSON');
          if (type === 'config') return options.config || {enabled: true, vapidKey: VAPID};
          if (type === 'register') return options.registerResponse || {ok: true};
          return options.unregisterResponse || {ok: true};
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(`let messaging=null,callNotificationRegistration=null,callWorkerPending=null,pushSetupPending=null;
    let pushSetupEmp="",pushSessionVersion=0,pushOptedOut=localStorage.getItem("sg_push_opted_out")==="1";
    const displayedCallKeys=new Set();let pushConnection={mode:"idle",emp:"",reason:""};\n${source}\n${logoutSource}`, context);
  return {context, notices, requests, toasts, stored, events, modals, tokenCalls, deletes, registration, client,
    run: code => vm.runInContext(code, context),
    state: () => vm.runInContext('pushConnection', context),
    view: () => context.pushConnectionView(),
    calls: type => requests.filter(r => r.url === ENDPOINTS[type]),
  };
}
function call(overrides = {}) {
  return {id: '2026-10-16_1234', emp: '1234', date: '2026-10-16', time: '11:40', queueNumber: 1,
    status: 'reserved', callStatus: 'called', callBatchId: 'batch-1', ...overrides};
}
function payload(overrides = {}) {
  return {data: {emp: '1234', reservationId: '2026-10-16_1234', callBatchId: 'batch-1', expiresAt: String(Date.now() + 60000), ...overrides}};
}

test('browser permission alone does not claim background connection', () => {
  const h = setup(); assert.notEqual(h.view().remote, true); assert.notEqual(h.view().on, true);
});
test('blank inline key loads public config by GET then registers only token and employee', async () => {
  const h = setup(); await h.context.setupPushMessaging(true);
  assert.equal(h.state().mode, 'push'); assert.equal(h.view().remote, true);
  assert.equal(h.calls('config').length, 1); assert.equal(h.calls('config')[0].request.method, 'GET');
  assert.equal(h.calls('config')[0].request.body, undefined);
  assert.equal(h.calls('register').length, 1); assert.equal(h.calls('register')[0].request.method, 'POST');
  assert.deepEqual(JSON.parse(h.calls('register')[0].request.body), {token: 'token-for-device', emp: '1234'});
  assert.deepEqual(JSON.parse(h.stored.get('sg_push_device')), {token: 'token-for-device', emp: '1234'});
  assert.equal(h.tokenCalls[0].vapidKey, VAPID); assert.equal(h.tokenCalls[0].serviceWorkerRegistration, h.registration);
  assert.equal(h.stored.has('sg_push_enabled'), false);
  assert.equal(typeof h.client.foreground, 'function');
});
test('inline public key avoids a config request', async () => {
  const h = setup({inline: true}); await h.context.setupPushMessaging(true);
  assert.equal(h.calls('config').length, 0); assert.equal(h.state().mode, 'push');
});
test('disabled server config keeps app-open delivery without claiming background success', async () => {
  const h = setup({config: {enabled: false, vapidKey: ''}}); await h.context.setupPushMessaging(true);
  assert.equal(h.state().mode, 'local'); assert.notEqual(h.view().remote, true);
  assert.equal(h.calls('register').length, 0); assert.equal(h.tokenCalls.length, 0);
});
for (const [name, options] of [
  ['invalid public key', {config: {enabled: true, vapidKey: 'bad'}}],
  ['empty token', {token: ''}], ['HTTP registration failure', {httpFailure: 'register'}],
  ['unconfirmed registration', {registerResponse: {ok: false}}],
  ['invalid registration JSON', {invalidJSON: 'register'}], ['network failure', {failEndpoint: 'register'}],
]) {
  test(`${name} never claims a background connection`, async () => {
    const h = setup(options); await h.context.setupPushMessaging(true);
    assert.equal(h.state().mode, 'local'); assert.equal(h.state().reason, 'failed');
    assert.notEqual(h.view().remote, true); assert.equal(h.stored.has('sg_push_device'), false);
  });
}
test('unsupported Firebase messaging preserves local display without register requests', async () => {
  const h = setup({supported: false}); await h.context.setupPushMessaging(true);
  assert.equal(h.state().mode, 'local'); assert.equal(h.calls('register').length, 0);
});
test('denied permission produces no connection requests', async () => {
  const h = setup({permission: 'denied'}); await h.context.setupPushMessaging(true);
  assert.equal(h.requests.length, 0); assert.notEqual(h.view().on, true); assert.match(h.toasts[0], /설정/);
});
test('worker failure cannot be reported as a connected notification system', async () => {
  const h = setup({workerFail: true}); await h.context.setupPushMessaging(true);
  assert.equal(h.state().mode, 'error'); assert.equal(h.calls('register').length, 0);
});
test('automatic setup is quiet without an employee or after persistent opt-out', async () => {
  for (const options of [{user: false}, {optedOut: true}]) {
    const h = setup(options); await h.context.setupPushMessaging(false);
    assert.equal(h.toasts.length, 0); assert.equal(h.requests.length, 0);
  }
});
test('iPhone browser opens installation guidance instead of requesting push permission', async () => {
  const h = setup({ios: true, permission: 'default'}); await h.context.enablePushNotifications();
  assert.equal(h.view().install, true); assert.equal(h.modals.length, 1);
  assert.equal(h.events.length, 0); assert.equal(h.requests.length, 0);
});
test('installed iPhone requests permission from the click before worker or network awaits', async () => {
  const h = setup({ios: true, standalone: true, permission: 'default', optedOut: true});
  await h.context.enablePushNotifications();
  assert.equal(h.events[0], 'permission'); assert.equal(h.state().mode, 'push');
  assert.equal(h.stored.has('sg_push_opted_out'), false);
});
test('repeated connection clicks share the pending connection', async () => {
  const h = setup(); await Promise.all([h.context.setupPushMessaging(true), h.context.setupPushMessaging(true)]);
  assert.equal(h.calls('register').length, 1); assert.equal(h.tokenCalls.length, 1);
});
test('another employee cannot see the previous employee connection as their own', async () => {
  const h = setup(); await h.context.setupPushMessaging(true); h.context.st.user = {emp: '5678'};
  assert.notEqual(h.view().remote, true); assert.notEqual(h.view().on, true);
});
test('switching employees revokes the saved device before registering the new employee', async () => {
  const old = {token: 'old-device', emp: '5678'}, h = setup({saved: old});
  await h.context.setupPushMessaging(true);
  assert.deepEqual(JSON.parse(h.calls('unregister')[0].request.body), old);
  assert.ok(h.events.indexOf(ENDPOINTS.unregister) < h.events.indexOf(ENDPOINTS.register));
  assert.equal(h.state().emp, '1234'); assert.equal(h.state().mode, 'push');
  assert.equal(JSON.parse(h.stored.get('sg_push_device')).emp, '1234');
});
test('switching employee also revokes old device when config is disabled', async () => {
  const h = setup({saved: {token: 'old-device', emp: '5678'}, config: {enabled: false, vapidKey: ''}});
  await h.context.setupPushMessaging(true);
  assert.equal(h.calls('unregister').length, 1); assert.equal(h.stored.has('sg_push_device'), false);
  assert.equal(h.calls('register').length, 0);
});
test('failed previous-device removal prevents a new registration and preserves retry information', async () => {
  const old = {token: 'old-device', emp: '5678'};
  const h = setup({saved: old, unregisterResponse: {ok: false}, deleteResult: false});
  await h.context.setupPushMessaging(true);
  assert.equal(h.calls('register').length, 0); assert.notEqual(h.view().remote, true);
  assert.deepEqual(JSON.parse(h.stored.get('sg_push_device')), old);
});
test('turning off a connected device revokes server registration and suppresses later automatic setup', async () => {
  const h = setup(); await h.context.setupPushMessaging(true);
  assert.equal(await h.context.disablePushNotifications(), true);
  assert.equal(h.stored.get('sg_push_opted_out'), '1'); assert.equal(h.stored.has('sg_push_device'), false);
  assert.equal(h.calls('unregister').length, 1); assert.equal(h.deletes.length, 1);
  const count = h.requests.length; await h.context.setupPushMessaging(false); assert.equal(h.requests.length, count);
  h.context.notifyCall(call()); h.context.receiveForegroundCall(payload()); await flush(); assert.equal(h.notices.length, 0);
});
test('turning off after reload can revoke a saved device before Firebase messaging is initialized', async () => {
  const h = setup({saved: {token: 'saved-device', emp: '1234'}});
  assert.equal(await h.context.disablePushNotifications(), true);
  assert.equal(h.calls('unregister').length, 1); assert.equal(h.stored.has('sg_push_device'), false);
});
test('failed unsubscribe preserves the device for retry and never reports completed removal', async () => {
  const h = setup({saved: {token: 'saved-device', emp: '1234'}, failEndpoint: 'unregister'});
  assert.equal(await h.context.disablePushNotifications(), false);
  assert.equal(h.stored.has('sg_push_device'), true); assert.equal(h.state().reason, 'unsubscribe');
  assert.match(h.toasts.at(-1), /실패/); assert.equal(h.stored.get('sg_push_opted_out'), '1');
});
test('logout opts out immediately and revokes this device asynchronously', async () => {
  const h = setup({saved: {token: 'saved-device', emp: '1234'}});
  h.context.logout();
  assert.equal(h.context.st.user, null); assert.equal(h.stored.get('sg_push_opted_out'), '1');
  await flush(); assert.equal(h.calls('unregister').length, 1); assert.equal(h.stored.has('sg_push_device'), false);
});
test('opt-out while a token request is pending prevents late registration', async () => {
  const token = deferred(); const h = setup({tokenHandler: () => token.promise});
  const connecting = h.context.setupPushMessaging(true); await flush(); assert.equal(h.tokenCalls.length, 1);
  const disabling = h.context.disablePushNotifications(); token.resolve('late-device');
  await Promise.all([connecting, disabling]);
  assert.equal(h.calls('register').length, 0); assert.equal(h.stored.has('sg_push_device'), false); assert.notEqual(h.view().remote, true);
});
for (const order of ['snapshot first', 'FCM first']) {
  test(`${order}: foreground FCM and reservation snapshots display a call only once`, async () => {
    const h = setup();
    if (order === 'snapshot first') { h.context.notifyCall(call()); h.context.receiveForegroundCall(payload()); }
    else {h.context.receiveForegroundCall(payload()); h.context.notifyCall(call());}
    await flush(); assert.equal(h.notices.length, 1);
    assert.equal(h.notices[0][1].data.callKey, '2026-10-16_1234:batch-1');
    h.context.notifyCall(call({callBatchId: 'batch-2'})); await flush(); assert.equal(h.notices.length, 2);
  });
}
test('expired, other-date and other-employee foreground pushes cannot display notifications', async () => {
  const h = setup();
  for (const overrides of [{expiresAt: String(Date.now() - 1000)}, {expiresAt: 'bad'}, {emp: '5678'}, {reservationId: '2026-10-15_1234'}, {callBatchId: ''}]) h.context.receiveForegroundCall(payload(overrides));
  await flush(); assert.equal(h.notices.length, 0);
});
test('past, canceled and another employee snapshots cannot display local notifications', async () => {
  const h = setup();
  for (const overrides of [{date: '2026-10-15'}, {status: 'cancelled'}, {emp: '5678'}, {callStatus: 'waiting'}]) h.context.notifyCall(call(overrides));
  await flush(); assert.equal(h.notices.length, 0);
});
test('registered push leaves hidden-tab delivery to the worker while local mode can still notify', async () => {
  const h = setup(); h.context.document.visibilityState = 'hidden';
  h.run('pushConnection={mode:"push",emp:"1234"};'); h.context.notifyCall(call()); await flush(); assert.equal(h.notices.length, 0);
  h.run('pushConnection.mode="local"'); h.context.notifyCall(call()); await flush(); assert.equal(h.notices.length, 1);
});
test('first installation waits for worker activation before displaying a notification', async () => {
  const h = setup(); let changed;
  const worker = {state: 'installing', addEventListener(type, listener) {changed = listener;}, removeEventListener() {}};
  h.registration.active = null; h.registration.installing = worker;
  const pending = h.context.showCallNotification('입장', '지금 입장'); await flush(); assert.equal(h.notices.length, 0);
  worker.state = 'activated'; h.registration.active = worker; changed(); await pending; assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0][1].icon, './icon-192.png');
});
test('opt-out while worker registration is pending prevents a delayed notification', async () => {
  const gate = deferred(), h = setup({workerGate: gate});
  const showing = h.context.showCallNotification('입장', '지금 입장'); await flush();
  await h.context.disablePushNotifications(); gate.resolve(); await showing; assert.equal(h.notices.length, 0);
});
test('notification timeout rejects rather than hanging', async () => {
  const h = setup(); await assert.rejects(h.context.notificationTimeout(new Promise(() => {}), 5), /NOTIFICATION_TIMEOUT/);
});

test('previous employee cleanup still runs when notifications are denied or Firebase messaging is unsupported', async () => {
  for (const extra of [{permission: 'denied'}, {supported: false}, {workerFail: true}]) {
    const h = setup({saved: {token: 'old-device', emp: '5678'}, ...extra});
    await h.context.setupPushMessaging(true);
    assert.equal(h.calls('unregister').length, 1);
    assert.equal(h.stored.has('sg_push_device'), false);
    assert.equal(h.calls('register').length, 0);
  }
});
test('switching employees preserves gesture permission before old-device cleanup network request', async () => {
  const h = setup({saved: {token: 'old-device', emp: '5678'}, permission: 'default'});
  await h.context.enablePushNotifications();
  assert.equal(h.events[0], 'permission');
  assert.ok(h.events.indexOf(ENDPOINTS.unregister) < h.events.indexOf(ENDPOINTS.register));
  assert.equal(h.state().mode, 'push');
});
test('notification display failure does not permanently consume the call deduplication key', async () => {
  const options = {displayFailure: true}, h = setup(options);
  h.context.notifyCall(call()); await flush(); assert.equal(h.notices.length, 0);
  options.displayFailure = false;
  h.context.receiveForegroundCall(payload()); await flush(); assert.equal(h.notices.length, 1);
});
test('changing employee while worker is loading suppresses the previous employee notification', async () => {
  const gate = deferred(), h = setup({workerGate: gate});
  const showing = h.context.showCallNotification('입장', '지금 입장'); await flush();
  h.context.st.user = {emp: '5678'};
  gate.resolve(); await showing; assert.equal(h.notices.length, 0);
});
test('opt-out during server registration cleans up late success instead of restoring push', async () => {
  const registered = deferred();
  const h = setup({fetchHandler: async url => {
    if (url === ENDPOINTS.register) await registered.promise;
    return {ok: true, json: async () => url === ENDPOINTS.config ? {enabled: true, vapidKey: VAPID} : {ok: true}};
  }});
  const connecting = h.context.setupPushMessaging(true); await flush(); assert.equal(h.calls('register').length, 1);
  const disabling = h.context.disablePushNotifications(); registered.resolve();
  await Promise.all([connecting, disabling]);
  assert.equal(h.calls('unregister').length, 1); assert.equal(h.stored.has('sg_push_device'), false);
  assert.equal(h.stored.get('sg_push_opted_out'), '1'); assert.notEqual(h.view().remote, true);
});
