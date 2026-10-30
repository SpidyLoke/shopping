// Beta tooling (functions/ops.js): error reports, feedback, and the owner's dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const load = () => import(path.join(ROOT, 'functions', 'ops.js'));

function fakeDb() {
  const docs = new Map();
  const copy = (v) => (v == null ? null : structuredClone(v));
  const inCol = (c) => [...docs.entries()].filter(([k]) => k.startsWith(`${c}/`) && k.split('/').length === 2).map(([, v]) => v);
  const ops = { '>': (a, b) => a > b, '==': (a, b) => a === b };
  return {
    docs,
    get: async (p) => copy(docs.get(p)),
    set: async (p, v) => { docs.set(p, copy(v)); },
    txn: async (fn) => {
      const writes = new Map();
      const r = await fn({ get: async (p) => copy(docs.get(p)), set: (p, v) => writes.set(p, copy(v)) });
      for (const [p, v] of writes) docs.set(p, v);
      return r;
    },
    count: async (c, where) => inCol(c).filter((d) => !where || ops[where[1]](d[where[0]], where[2])).length,
    recent: async (c, n) => inCol(c).sort((a, b) => b.at - a.at).slice(0, n).map(copy),
  };
}

const NOW = Date.UTC(2026, 9, 30, 4);

test('error reports are kept short, counted per day and capped per account', async () => {
  const ops = await load();
  const db = fakeDb();
  const deps = { db, clock: () => NOW };
  await ops.saveReport({ kind: 'error', message: 'TypeError: x is undefined', where: 'app.js:120', stack: 's'.repeat(5000), version: '2026.10.30-7', device: 'iPhone' }, { uid: 'u1', deps });
  const saved = [...db.docs.entries()].find(([k]) => k.startsWith('reports/'))[1];
  assert.equal(saved.stack.length, 2000);
  assert.equal(saved.uid, 'u1');
  assert.equal(db.docs.get('counters/day-2026-10-30').errors, 1);
  for (let i = 0; i < 25; i += 1) await ops.saveReport({ message: `e${i}` }, { uid: 'u1', deps });
  assert.equal(await db.count('reports'), 20);
  await assert.rejects(ops.saveReport({ message: '' }, { uid: 'u1', deps }), (e) => e.code === 'invalid-argument');
});

test('result feedback keeps the verdict, what was wrong and the figures, never a photo', async () => {
  const ops = await load();
  const db = fakeDb();
  const deps = { db, clock: () => NOW };
  await ops.saveFeedback({ verdict: 'wrong', wrong: ['model', 'used', 'nonsense'], note: 'It is the Edge version', product: { name: 'DualSense', barcode: '4948872415545', market: 'MY', price: 8980, myUsed: 220, photo: 'AAAA' } }, { uid: 'u1', deps });
  await ops.saveFeedback({ verdict: 'right', product: { name: 'Switch Lite' } }, { uid: 'u1', deps });
  const all = await db.recent('feedback', 10);
  const wrong = all.find((f) => f.verdict === 'wrong');
  assert.deepEqual(wrong.wrong, ['model', 'used']);
  assert.equal(wrong.product.myUsed, 220);
  assert.equal(JSON.stringify(wrong).includes('AAAA'), false);
  assert.deepEqual([db.docs.get('counters/day-2026-10-30').right, db.docs.get('counters/day-2026-10-30').wrong], [1, 1]);
  await assert.rejects(ops.saveFeedback({ type: 'general', note: ' ' }, { uid: 'u1', deps }), (e) => e.code === 'invalid-argument');
});

test('the dashboard is only for owners, and adds up the week', async () => {
  const ops = await load();
  const db = fakeDb();
  const deps = { db, clock: () => NOW };
  db.docs.set('counters/day-2026-10-30', { scans: 12, cached: 3, right: 4, wrong: 1 });
  db.docs.set('counters/day-2026-10-28', { scans: 8, errors: 2 });
  db.docs.set('users/a', { used: 3 });
  db.docs.set('users/b', { passUntil: NOW + 1000 });
  db.docs.set('users/c', { plan: 'pro', proUntil: NOW + 1000 });
  db.docs.set('users/d', { passUntil: NOW - 1000 });
  await ops.saveReport({ message: 'boom' }, { uid: 'u1', deps });
  await assert.rejects(ops.ownerStats({ uid: 'u1' }, { deps, owners: ['me'] }), (e) => e.code === 'permission-denied');
  const s = await ops.ownerStats({ uid: 'me' }, { deps, owners: ['me'] });
  assert.deepEqual(s.week, { scans: 20, cached: 3, errors: 3, right: 4, wrong: 1 });
  assert.equal(s.accuracy, 80);
  assert.equal(s.users, 4);
  assert.deepEqual(s.paying, { passes: 1, monthly: 1 });
  assert.equal(s.reports[0].message, 'boom');
  assert.equal(s.reports[0].stack, undefined);
  assert.equal(s.days.length, 7);
  assert.equal(ops.isOwner('', ['']), false);
});
