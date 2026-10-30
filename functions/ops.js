// Running the beta: error reports and feedback from the app, and a dashboard for the owner.
//
// Pure logic like core.js. Reports and feedback hold no photos: an error's message and where it
// happened, or a tester's verdict on a result with the product's name, barcode and the figures they
// judged. Both delete themselves after 90 days (expireAt) and are capped per account per day.

import { ScanError, dayKey, bump } from './core.js';

const DAY = 24 * 60 * 60 * 1000;
const KEEP = 90 * DAY;
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (Number.isFinite(v) ? v : null);
const newId = (now) => `${now}-${Math.random().toString(36).slice(2, 8)}`;

async function capped(db, path, field, limit) {
  return db.txn(async (t) => {
    const doc = (await t.get(path)) || {};
    if ((doc[field] || 0) >= limit) return false;
    t.set(path, { ...doc, [field]: (doc[field] || 0) + 1, expireAt: new Date(Date.now() + 2 * DAY) });
    return true;
  });
}

export async function saveReport(input, { uid, deps }) {
  const { db } = deps;
  const now = (deps.clock || Date.now)();
  const message = text(input?.message, 500);
  if (!message) throw new ScanError('invalid-argument', 'Empty report.');
  if (!(await capped(db, `ipDaily/reports-${dayKey(now)}-${uid}`, 'n', 20))) return { saved: false };
  await db.set(`reports/${newId(now)}`, {
    uid, at: now, kind: input.kind === 'scan' ? 'scan' : 'error', message,
    where: text(input.where, 300), stack: text(input.stack, 2000), version: text(input.version, 30),
    device: text(input.device, 200), expireAt: new Date(now + KEEP),
  });
  await bump(db, `counters/day-${dayKey(now)}`, input.kind === 'scan' ? 'scanErrors' : 'errors');
  return { saved: true };
}

const WRONG = ['model', 'new', 'used', 'cex', 'price', 'other'];

export async function saveFeedback(input, { uid, deps }) {
  const { db } = deps;
  const now = (deps.clock || Date.now)();
  const general = input?.type === 'general';
  const verdict = input?.verdict === 'right' ? 'right' : 'wrong';
  const note = text(input?.note, 1000);
  if (general && !note) throw new ScanError('invalid-argument', 'Write something first.');
  if (!(await capped(db, `ipDaily/feedback-${dayKey(now)}-${uid}`, 'n', 50))) throw new ScanError('resource-exhausted', 'That\'s a lot of feedback for one day. Thank you! Try again tomorrow.');
  const p = input?.product || {};
  await db.set(`feedback/${newId(now)}`, {
    uid, at: now, type: general ? 'general' : 'result', note, version: text(input?.version, 30),
    ...(general ? {} : {
      verdict,
      wrong: verdict === 'wrong' && Array.isArray(input.wrong) ? input.wrong.filter((w) => WRONG.includes(w)) : [],
      product: {
        name: text(p.name, 200), barcode: text(p.barcode, 14), market: text(p.market, 2), currency: text(p.currency, 3),
        price: num(p.price), myNew: num(p.myNew), myUsed: num(p.myUsed), cexCash: num(p.cexCash), identifiedBy: text(p.identifiedBy, 20),
      },
    }),
    expireAt: new Date(now + KEEP),
  });
  if (!general) await bump(db, `counters/day-${dayKey(now)}`, verdict === 'right' ? 'right' : 'wrong');
  return { saved: true };
}

// The owner's view: owners are the account IDs in OWNER_UIDS (Settings shows yours).
export const isOwner = (uid, owners) => Boolean(uid) && owners.includes(uid);

export async function ownerStats({ uid }, { deps, owners }) {
  if (!isOwner(uid, owners)) throw new ScanError('permission-denied', 'Only the app\'s owner can see this.');
  const { db } = deps;
  const now = (deps.clock || Date.now)();
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const day = dayKey(now - i * DAY);
    days.push({ day, ...((await db.get(`counters/day-${day}`)) || {}) });
  }
  const sum = (k) => days.reduce((t, d) => t + (d[k] || 0), 0);
  const [users, passes, monthly, reports, feedback] = await Promise.all([
    db.count('users'),
    db.count('users', ['passUntil', '>', now]),
    db.count('users', ['proUntil', '>', now]),
    db.recent('reports', 8),
    db.recent('feedback', 8),
  ]);
  const judged = sum('right') + sum('wrong');
  return {
    today: days[0],
    week: { scans: sum('scans'), cached: sum('cached'), errors: sum('errors') + sum('scanErrors'), right: sum('right'), wrong: sum('wrong') },
    days,
    accuracy: judged ? Math.round((sum('right') / judged) * 100) : null,
    users, paying: { passes, monthly },
    reports: reports.map(({ uid: u, expireAt, stack, ...r }) => ({ ...r, account: u?.slice(0, 6) })),
    feedback: feedback.map(({ uid: u, expireAt, ...f }) => ({ ...f, account: u?.slice(0, 6) })),
  };
}
