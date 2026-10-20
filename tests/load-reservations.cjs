#!/usr/bin/env node
'use strict';

// Opt-in integration/load check. Never connects to the production Firebase project.
// npm install --prefix /tmp/bapsang-load-env firebase@10.12.5
// FIRESTORE_EMULATOR_HOST=127.0.0.1:8787 NODE_PATH=/tmp/bapsang-load-env/node_modules \
//   node tests/load-reservations.cjs --output /tmp/bapsang-load-result.json
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');

const host = process.env.FIRESTORE_EMULATOR_HOST;
assert.ok(host && /^(127\.0\.0\.1|localhost):\d+$/.test(host),
  'An explicit local FIRESTORE_EMULATOR_HOST is required. Production testing is prohibited.');
const [hostname, portText] = host.split(':');
const port = Number(portText);
const projectId = process.env.BAPSANG_LOAD_PROJECT || 'demo-bapsang-load';
assert.ok(/^demo-bapsang-load(?:-[a-z0-9-]+)?$/.test(projectId),
  'Only a demo-bapsang-load emulator project may be used.');
const firebase = require('firebase/compat/app');
require('firebase/compat/firestore');
firebase.firestore.setLogLevel('silent');
const htmlPath = process.env.BAPSANG_HTML || path.join(__dirname, '../index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const slotLiteral = html.match(/^const SLOTS=(\[[^;]+\]);/m);
assert.ok(slotLiteral, 'Production SLOTS definition is present');
const SLOTS = JSON.parse(slotLiteral[1]);
const starts = [...html.matchAll(/^(?:async )?function [A-Za-z_$][\w$]*\(/gm)];
function functionSource(name) {
  const i = starts.findIndex(m => m[0].includes(`function ${name}(`));
  assert.ok(i >= 0, `${name} exists in production HTML`);
  return html.slice(starts[i].index, starts[i + 1]?.index || html.length);
}
const source = ['queueLedgerPatch', 'reserveFirebase', 'cancelFirebase', 'partySizeOf',
  'docId', 'slotId', 'queueControlKey', 'code', 'slotIndex', 'isEligibleTime']
  .map(functionSource).join('\n');
const day = '2099-12-20';
const org = { key: 'planning', name: '기획·홍보·감사·비서' };
let serial = 0;
// Firebase checks plain-object prototypes in its own realm. Only bridge VM plain
// objects/arrays; SDK sentinel instances (e.g. serverTimestamp) remain untouched.
function sdkValue(value) {
  if (Array.isArray(value)) return Array.from(value, sdkValue);
  if (value && Object.getPrototypeOf(value)?.constructor?.name === 'Object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sdkValue(item)]));
  return value;
}
function newDatabase(label) {
  const app = firebase.initializeApp({ projectId, apiKey: 'demo-local-only',
    appId: `demo-local-only:${++serial}` }, `load-${label}-${process.pid}-${serial}`);
  const db = app.firestore();
  db.useEmulator(hostname, port);
  return { app, db };
}
function client(emp, slot = '11:40', partySize = 1, fault = null) {
  const backend = newDatabase(emp);
  const state = { toasts: [], errors: [], transactionCalls: 0, attempts: 0,
    reads: 0, writes: 0, commits: 0, canceled: false };
  // Instrument SDK calls without serializing them or changing SDK retry behavior.
  const db = {
    collection: name => backend.db.collection(name),
    runTransaction: async callback => {
      state.transactionCalls++;
      if (fault) throw Object.assign(new Error(fault), { code: fault });
      const value = await backend.db.runTransaction(async tx => {
        state.attempts++;
        return callback({
          get: ref => { state.reads++; return tx.get(ref); },
          set: (ref, data, options) => {
            state.writes++; if (options) tx.set(ref, sdkValue(data), sdkValue(options));
            else tx.set(ref, sdkValue(data));
          },
          update: (ref, data) => { state.writes++; tx.update(ref, sdkValue(data)); }
        });
      });
      state.commits++;
      return value;
    }
  };
  const user = { emp, name: `부하검증${emp}`, dept: '기획실', orgKey: org.key };
  const c = { SLOTS, db, firebase, Date, Math, Number, String, Object,
    setTimeout, clearTimeout, navigator: { onLine: true },
    dataEpoch: 0, confirmedReservations: new Map(), dataState: { reservation: 'loading' },
    reservationSnapshotReady: false, listenOwnQueue() {}, refreshOverview: async () => {},
    console: { error: e => state.errors.push({ code: e?.code || null, message: String(e?.message || e) }) },
    st: { user, slot, reservations: [], date: day },
    todayDate: () => day, userOrganization: () => org,
    selectedPartySize: () => partySize, assignedSlot: () => SLOTS[0][0],
    isOverflowChoice: () => false, overflowQuotaReleased: () => true,
    EARLY_OVERFLOW_QUOTA: 12, reservationWindowOpen: () => true,
    reservationWindowMessage: () => '예약 가능시간 10:00~11:00',
    isLateReservationStatus: s => s === 'late' || s === 'late_reserved',
    lateReservationNotice: () => '마감 후 예약',
    go() {}, render() {}, toast: s => state.toasts.push(s)
  };
  vm.createContext(c); vm.runInContext(source, c);
  return { backend, state, c, emp, slot, partySize,
    async close() { await backend.db.terminate(); await backend.app.delete(); }
  };
}
async function clearTestProject() {
  const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: 'DELETE' });
  assert.ok(response.ok, `Cannot clear isolated emulator project: HTTP ${response.status}`);
}
async function inspect() {
  const auditor = newDatabase('auditor');
  try {
    const [reservationsSnap, countsSnap] = await Promise.all([
      auditor.db.collection('reservations').get(), auditor.db.collection('slotCounts').get()
    ]);
    const reservations = reservationsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const counts = countsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const violations = [];
    const slots = SLOTS.map(([time, capacity]) => {
      const rows = reservations.filter(r => r.time === time && r.status === 'reserved');
      const actual = rows.reduce((sum, r) => sum + r.partySize, 0);
      const record = counts.find(r => r.time === time);
      const recorded = record?.count || 0;
      const queueNumbers = rows.map(r => r.queueNumber);
      if (actual !== recorded) violations.push(`${time}: actual ${actual} != recorded ${recorded}`);
      if (actual > capacity || recorded > capacity || recorded < 0) violations.push(`${time}: capacity violation`);
      if (new Set(queueNumbers).size !== queueNumbers.length) violations.push(`${time}: duplicate queue numbers`);
      const waiting = Object.values(record?.queueEntries || {})
        .reduce((sum, entry) => sum + (entry.waiting ? entry.size : 0), 0);
      if (waiting !== actual) violations.push(`${time}: waiting ledger ${waiting} != reserved ${actual}`);
      return { time, capacity, actualPeople: actual, recordedPeople: recorded, reservations: rows.length, waiting };
    });
    if (new Set(reservations.map(r => `${r.date}_${r.emp}`)).size !== reservations.length)
      violations.push('Duplicate reservation identity');
    return { slots, reservationDocuments: reservations.length,
      activeReservations: reservations.filter(r => r.status === 'reserved').length,
      activePeople: slots.reduce((sum, s) => sum + s.actualPeople, 0),
      cancelledReservations: reservations.filter(r => r.status === 'cancelled').length,
      consistent: violations.length === 0, violations };
  } finally { await auditor.db.terminate(); await auditor.app.delete(); }
}
function classify(state) {
  const last = state.toasts.at(-1) || '';
  if (last.includes('예약이 완료') || last.includes('예약이 확인되었습니다')) return 'booked';
  if (last === '선택한 시간은 마감되었습니다.') return 'full';
  if (last === '이미 오늘 예약이 있습니다.') return 'duplicate';
  if (last === '예약이 취소되었습니다.') return 'cancelled';
  if (last === '이미 취소된 예약입니다.') return 'already_cancelled';
  return 'error';
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
}
async function wave(clients, action = 'book', timeoutMs = 60000) {
  const started = performance.now();
  let timer;
  const result = [];
  const jobs = clients.map(async c => {
    const start = performance.now();
    try {
      if (action === 'cancel') await c.c.cancelFirebase(`${day}_${c.emp}`);
      else await c.c.reserveFirebase();
      result.push({ emp: c.emp, time: c.slot, size: c.partySize,
        elapsedMs: performance.now() - start, outcome: classify(c.state),
        ...c.state, pending: c.c.reserveFirebase.pending === true });
    } catch (e) {
      result.push({ emp: c.emp, elapsedMs: performance.now() - start,
        outcome: 'uncaught', error: String(e.message || e), ...c.state });
    }
  });
  const timedOut = await Promise.race([
    Promise.all(jobs).then(() => false),
    new Promise(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); })
  ]);
  clearTimeout(timer);
  const outcomes = result.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] || 0) + 1 }), {});
  const durations = result.map(r => r.elapsedMs);
  const summary = { requested: clients.length, completed: result.length, timedOut,
    elapsedMs: Math.round(performance.now() - started), outcomes,
    latencyMs: { p50: percentile(durations, 0.5), p95: percentile(durations, 0.95), max: Math.round(Math.max(0, ...durations)) },
    transactionAttempts: result.reduce((n, r) => n + r.attempts, 0),
    transactionCalls: result.reduce((n, r) => n + r.transactionCalls, 0),
    bookedPeople: result.filter(r => r.outcome === 'booked').reduce((n, r) => n + r.size, 0),
    pendingAfterCompletion: result.filter(r => r.pending).length,
    errors: result.filter(r => ['error', 'uncaught'].includes(r.outcome)).slice(0, 8)
      .map(r => ({ emp: r.emp, errors: r.errors, toast: r.toasts?.at(-1), uncaught: r.error }))
  };
  if (timedOut) {
    // Abort clients before the audit; terminated writes cannot leak into another scenario.
    await Promise.allSettled(clients.map(c => c.close()));
    await Promise.allSettled(jobs);
  }
  return summary;
}

const scenarios = [
  { name: 'single-50', count: 50 },
  { name: 'single-100', count: 100 },
  { name: 'single-400', count: 400 },
  { name: 'distributed-400', count: 400, distributed: true },
  { name: 'groups-100', count: 100, distributed: true, groups: true },
  { name: 'duplicate-20', count: 20, duplicate: true },
  { name: 'cancel-duplicate-40', count: 20, cancellation: true },
  { name: 'server-unavailable', count: 1, fault: 'unavailable' },
  { name: 'permission-denied', count: 1, fault: 'permission-denied' }
];
const args = process.argv.slice(2);
const chosen = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1].split(',') : scenarios.map(s => s.name);
const output = args.includes('--output') ? path.resolve(args[args.indexOf('--output') + 1]) : null;
const report = { timestamp: new Date().toISOString(), environment: 'local-firestore-emulator',
  projectId, emulator: host, sdk: firebase.SDK_VERSION,
  source: path.relative(process.cwd(), htmlPath),
  sourceSha256: createHash('sha256').update(html).digest('hex'),
  productionWrites: false, note: 'Emulator timing is not a production throughput guarantee. Fault cases inject SDK rejections.',
  scenarios: [] };

function validateScenario(spec, result) {
  const checks = [];
  const check = (description, passed) => checks.push({ description, passed: Boolean(passed) });
  const count = key => result.outcomes[key] || 0;
  const complete = part => !part.timedOut && part.completed === part.requested &&
    part.pendingAfterCompletion === 0 && !(part.outcomes.uncaught || 0);
  const integrityPass = result.audit.consistent && (!result.afterCancellation || result.afterCancellation.consistent);
  const unexpectedErrors = (count('error') + count('uncaught')) - (spec.fault ? 1 : 0);
  const completionPass = complete(result) && unexpectedErrors === 0 &&
    (!result.cancellation || (complete(result.cancellation) && !result.cancellation.outcomes.error));
  check('All requests completed within 60 seconds and released pending state', completionPass);
  if (spec.fault) {
    check('Injected SDK rejection was caught with an error notice', count('error') === 1 &&
      result.errors.some(item => item.errors?.some(error => error.code === spec.fault) && item.toast));
    check('Injected failure created no reservation or seat count', result.audit.reservationDocuments === 0 && result.audit.activePeople === 0);
  } else if (spec.duplicate) {
    check('One employee gets exactly one reservation across 20 devices', count('booked') === 1 && count('duplicate') === 19);
    check('One reservation and one occupied seat exist', result.audit.activeReservations === 1 && result.audit.activePeople === 1);
  } else if (spec.cancellation) {
    check('All 20 initial reservations succeeded', count('booked') === 20);
    check('Each duplicate cancellation changes the reservation once', result.cancellation?.outcomes.cancelled === 20 && result.cancellation?.outcomes.already_cancelled === 20);
    check('All 20 reservations are cancelled and every seat is restored', result.afterCancellation?.cancelledReservations === 20 && result.afterCancellation?.activePeople === 0);
  } else if (spec.groups) {
    check('Every mixed-size party is booked or rejected as full', count('booked') + count('full') === spec.count);
    check('Group booking actually occupied seats', count('booked') > 0 && result.audit.activePeople > 0);
    if (result.bookedPeople !== undefined) check('Successful party sizes equal the stored head count', result.bookedPeople === result.audit.activePeople);
  } else {
    const booked = spec.distributed ? 250 : Math.min(spec.count, 50);
    check(`Exactly ${booked} reservations succeed and ${spec.count - booked} are full`, count('booked') === booked && count('full') === spec.count - booked);
    check(`The database stores exactly ${booked} occupied seats`, result.audit.activePeople === booked && result.audit.activeReservations === booked);
  }
  return { integrityPass, completionPass, scenarioPass: integrityPass && checks.every(item => item.passed), checks };
}

async function runScenario(spec) {
  await clearTestProject();
  const clients = Array.from({ length: spec.count }, (_, i) => client(
    spec.duplicate ? '1000' : String(1000 + i),
    spec.distributed ? SLOTS[i % SLOTS.length][0] : SLOTS[0][0],
    spec.groups ? [1, 2, 3, 5, 10][Math.floor(i / SLOTS.length) % 5] : 1,
    spec.fault
  ));
  try {
    const booking = await wave(clients);
    const bookingAudit = await inspect();
    const scenario = { name: spec.name, ...booking, audit: bookingAudit };
    if (spec.cancellation && !booking.timedOut) {
      const cancellations = clients.filter(c => classify(c.state) === 'booked')
        .flatMap(c => [client(c.emp), client(c.emp)]);
      try { scenario.cancellation = await wave(cancellations, 'cancel'); }
      finally { await Promise.allSettled(cancellations.map(c => c.close())); }
      scenario.afterCancellation = await inspect();
    }
    return { ...scenario, validation: validateScenario(spec, scenario) };
  } finally { await Promise.allSettled(clients.map(c => c.close())); }
}
(async () => {
  if (args.includes('--validate-report')) {
    const reportPath = path.resolve(args[args.indexOf('--validate-report') + 1]);
    const prior = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    for (const result of prior.scenarios) {
      const spec = scenarios.find(item => item.name === result.name);
      assert.ok(spec, `Unknown scenario ${result.name}`);
      result.validation = validateScenario(spec, result);
    }
    fs.writeFileSync(reportPath, JSON.stringify(prior, null, 2) + '\n');
    console.log(JSON.stringify({ report: reportPath, validations: prior.scenarios.map(item => ({ name: item.name, ...item.validation })) }));
    if (prior.scenarios.some(item => !item.validation.scenarioPass)) process.exitCode = 1;
    return;
  }
  for (const name of chosen) {
    const spec = scenarios.find(s => s.name === name);
    assert.ok(spec, `Unknown scenario: ${name}`);
    const result = await runScenario(spec);
    report.scenarios.push(result);
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(result));
  }
  if (report.scenarios.some(s => !s.validation.scenarioPass)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
