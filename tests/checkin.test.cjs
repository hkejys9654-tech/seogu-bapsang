const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function checkinValidationMessage(');
const end = html.indexOf('function historyView()', start);
assert.ok(start >= 0 && end > start, 'extract the actual app check-in functions');
const ledgerStart = html.indexOf('function queueLedgerPatch(');
const ledgerEnd = html.indexOf('async function reserve(', ledgerStart);
assert.ok(ledgerStart >= 0 && ledgerEnd > ledgerStart, 'extract actual queue ledger helper');
const source = html.slice(ledgerStart, ledgerEnd) + html.slice(start, end);
const today = '2026-10-16';
const qr = `SGMEAL|${today}|11:40|0123`;
function reservation(overrides = {}) {
  return {id: `${today}_0123`, name: '테스트', emp: '0123', date: today,
    time: '11:40', partySize: 3, queueNumber: 1, status: 'reserved', callStatus: 'called',
    qrEligible: true, code: qr, ...overrides};
}
function app({cloud = false, row = reservation(), localRow = row, penalty = null,
  localPenalty = null, retryWith = null, connectionError = false} = {}) {
  const data = new Map();
  if (row) data.set(`reservations/${row.id}`, {...row});
  const summaryRef = row ? `slotCounts/${row.date}_${row.time.replace(':', '')}` : '';
  if (row && row.status === 'reserved' && row.qrEligible !== false) data.set(summaryRef, {date: row.date, time: row.time, count: row.partySize + 2, nextQueueNumber: 7, queueLedgerVersion: 1, queueEntries: {[row.queueNumber]: {size: row.partySize, waiting: row.callStatus !== 'called' && row.callStatus !== 'passed'}, 7: {size: 2, waiting: true}}});
  if (penalty) data.set('penalties/0123', {...penalty});
  const stats = {writes: 0, reservationWrites: 0, ledgerWrites: 0, transactions: 0, attempts: 0, saves: 0, renders: 0, reads: [], toasts: []};
  let retried = false;
  const context = {
    console: {error() {}}, firebaseOn: cloud,
    st: {reservations: localRow ? [{...localRow}] : [], penalties: localPenalty ? {'0123': localPenalty} : {}},
    todayDate: () => today, slotId: (date, time) => `${date}_${time.replace(':', '')}`, docId: (date, emp) => `${date}_${emp}`,
    isLateReservationStatus: status => status === 'late' || status === 'late_reserved',
    partySizeOf: row => Math.max(1, Math.min(10, Math.trunc(Number(row && row.partySize) || 1))),
    saveLocal: () => stats.saves++, render: () => stats.renders++,
    toast: message => stats.toasts.push(message),
    firebase: {firestore: {FieldValue: {serverTimestamp: () => 'SERVER_TIME'}}},
    db: {
      collection: collection => ({doc: id => `${collection}/${id}`}),
      async runTransaction(callback) {
        stats.transactions++;
        if (connectionError) throw new Error('offline');
        for (;;) {
          stats.attempts++;
          const writes = [];
          const result = await callback({
            async get(ref) {
              assert.equal(writes.length, 0, 'all reads must precede writes');
              stats.reads.push(ref);
              const record = data.get(ref);
              return {exists: !!record, data: () => ({...record})};
            },
            update: (ref, value) => writes.push([ref, value]),
            set: (ref, value, options) => { assert.equal(options.merge, true); writes.push([ref, value]); },
          });
          // Firestore retries the callback if any read document changes before commit.
          if (retryWith && !retried) {
            retried = true;
            const key = `reservations/${row.id}`;
            data.set(key, {...data.get(key), ...retryWith});
            continue;
          }
          for (const [ref, value] of writes) {
            data.set(ref, {...data.get(ref), ...value});
            stats.writes++;
            if (ref.startsWith('reservations/')) stats.reservationWrites++;
            if (ref.startsWith('slotCounts/')) stats.ledgerWrites++;
          }
          return result;
        }
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {context, stats, data,
    get summary() {return data.get(summaryRef);},
    get stored() { return cloud ? data.get(`reservations/${row.id}`) : context.st.reservations[0]; }};
}

for (const cloud of [false, true]) {
  const mode = cloud ? 'Firestore' : 'local';
  test(`${mode}: a current called group checks in once with exact QR`, async () => {
    const a = app({cloud});
    assert.match(await a.context.checkinByCode(qr), /3명 입장 처리 완료/);
    assert.equal(a.stored.status, 'checkedin');
    assert.match(await a.context.checkinByCode(qr), /이미 입장/);
    assert.equal(cloud ? a.stats.reservationWrites : a.stats.saves, 1);
    if (cloud) {
      assert.equal(a.stats.writes, 2); assert.equal(a.stats.ledgerWrites, 1);
      assert.equal(a.summary.count, 5, 'check-in must not release booked capacity');
      assert.deepEqual(JSON.parse(JSON.stringify(a.summary.queueEntries)), {'1': {size: 0, waiting: false}, '7': {size: 2, waiting: true}}, 'only the checked-in entry is tombstoned');
    }
  });
  test(`${mode}: direct entry rejects past and future reservations`, async () => {
    for (const date of ['2026-10-15', '2026-10-17']) {
      const a = app({cloud, row: reservation({date})});
      await a.context.checkin(`${today}_0123`);
      assert.match(a.stats.toasts[0], /오늘 날짜/);
      assert.equal(a.stored.status, 'reserved');
    }
  });
  test(`${mode}: QR entry rejects a past-day ticket`, async () => {
    const past = 'SGMEAL|2026-10-15|11:40|0123';
    const a = app({cloud, row: reservation({id: '2026-10-15_0123', date: '2026-10-15', code: past})});
    assert.match(await a.context.checkinByCode(past), /오늘 날짜/);
    assert.equal(a.stored.status, 'reserved');
  });
  test(`${mode}: canceled, noshow, duplicate, unknown statuses cannot be checked in`, async () => {
    for (const status of ['cancelled', 'noshow', 'checkedin', 'unknown']) {
      const a = app({cloud, row: reservation({status})});
      await a.context.checkin(`${today}_0123`);
      assert.doesNotMatch(a.stats.toasts[0], /처리 완료/);
      assert.doesNotMatch(await a.context.checkinByCode(qr), /처리 완료/);
      assert.equal(a.stored.status, status);
      assert.equal(a.stats.writes + a.stats.saves, 0);
    }
  });
  test(`${mode}: malformed or nonmatching QR cannot fall back to date and employee`, async () => {
    for (const code of [qr.replace('SGMEAL', 'OTHER'), `${qr}|extra`, qr.replace('11:40', '12:10'), 'arbitrary', 'SGMEAL|2026-10-16|11:40|../0123']) {
      const a = app({cloud});
      assert.doesNotMatch(await a.context.checkinByCode(code), /처리 완료/);
      assert.equal(a.stored.status, 'reserved');
      assert.equal(a.stats.writes + a.stats.saves, 0);
    }
  });
  test(`${mode}: QR requires eligibility and current called state`, async () => {
    for (const override of [{qrEligible: false}, {status: 'late'}, {status: 'late_reserved'}, {callStatus: 'waiting'}, {callStatus: 'passed'}, {code: ''}]) {
      const a = app({cloud, row: reservation(override)});
      assert.doesNotMatch(await a.context.checkinByCode(qr), /처리 완료/);
      assert.equal(a.stats.writes + a.stats.saves, 0);
    }
  });
  test(`${mode}: manual demo entry preserves late bookings and call overrides`, async () => {
    for (const override of [{status: 'late', qrEligible: false, code: ''}, {status: 'late_reserved'}, {callStatus: 'passed'}, {callStatus: 'waiting'}]) {
      const a = app({cloud, row: reservation(override)});
      await a.context.checkin(`${today}_0123`);
      assert.match(a.stats.toasts[0], /3명 입장 처리 완료/);
      assert.equal(a.stored.status, 'checkedin');
    }
  });
  test(`${mode}: a requeued reservation retains its full issued QR`, async () => {
    const a = app({cloud, row: reservation({time: '12:10'})});
    assert.match(await a.context.checkinByCode(qr), /완료: 12:10/);
    assert.equal(a.stored.status, 'checkedin');
  });
  test(`${mode}: active penalty blocks both manual and QR entry`, async () => {
    const p = {blockDate: today};
    const a = app({cloud, penalty: p, localPenalty: cloud ? null : p});
    await a.context.checkin(`${today}_0123`);
    assert.match(a.stats.toasts[0], /노쇼 제한/);
    assert.match(await a.context.checkinByCode(qr), /노쇼 제한/);
    assert.equal(a.stored.status, 'reserved');
  });
  test(`${mode}: missing reservations show a failure without writing`, async () => {
    const a = app({cloud, row: null});
    await a.context.checkin(`${today}_0123`);
    assert.match(a.stats.toasts[0], /찾지 못/);
    assert.match(await a.context.checkinByCode(qr), /찾지 못/);
    assert.equal(a.stats.writes + a.stats.saves, 0);
  });
}

test('Firestore: current server status and group size take precedence over stale cache', async () => {
  const a = app({cloud: true, row: reservation({partySize: 5}), localRow: reservation({status: 'cancelled'})});
  await a.context.checkin(`${today}_0123`);
  assert.match(a.stats.toasts[0], /5명 입장 처리 완료/);
  assert.deepEqual(a.stats.reads, [`reservations/${today}_0123`, 'penalties/0123', `slotCounts/${today}_1140`]);
  assert.equal(a.stats.reservationWrites, 1); assert.equal(a.stats.ledgerWrites, 1);
  assert.equal(a.summary.count, 7);
  assert.deepEqual(JSON.parse(JSON.stringify(a.summary.queueEntries['1'])), {size: 0, waiting: false});
  assert.equal(a.stats.transactions, 1);
});

test('Firestore: transaction retries reject a concurrent cancellation or check-in', async () => {
  for (const status of ['cancelled', 'checkedin']) {
    for (const method of ['manual', 'qr']) {
      const a = app({cloud: true, retryWith: {status}});
      const message = method === 'qr'
        ? await a.context.checkinByCode(qr)
        : (await a.context.checkin(`${today}_0123`), a.stats.toasts[0]);
      assert.doesNotMatch(message, /처리 완료/);
      assert.equal(a.stored.status, status);
      assert.equal(a.stats.attempts, 2);
      assert.equal(a.stats.writes, 0);
      assert.equal(a.stats.reservationWrites, 0); assert.equal(a.stats.ledgerWrites, 0);
      assert.equal(a.summary.count, 5);
      assert.equal(a.summary.queueEntries['1'].size, 3);
    }
  }
});

test('Firestore: changed call status is checked again after a transaction retry', async () => {
  const a = app({cloud: true, retryWith: {callStatus: 'passed'}});
  assert.match(await a.context.checkinByCode(qr), /호출이 지났/);
  assert.equal(a.stats.writes, 0);
});

test('Firestore: connection failure returns an actionable message instead of success', async () => {
  const a = app({cloud: true, connectionError: true});
  await a.context.checkin(`${today}_0123`);
  assert.match(a.stats.toasts[0], /연결 상태/);
  assert.match(await a.context.checkinByCode(qr), /연결 상태/);
  assert.equal(a.stats.writes, 0);
});
