// Weekly summary email for Mukoma Bob's ledger.
// Runs on GitHub Actions every Sunday. Reads from Supabase, sends via Gmail.

const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zxwlygksmqcrrmazople.supabase.co';
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim().replace(/^["']|["']$/g, '');
const GMAIL_USER = (process.env.GMAIL_USER || '').trim();
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '');
const RECIPIENT = process.env.RECIPIENT_EMAIL;

// Fail early with a clear message if a secret is missing.
const missing = [
  ['SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY],
  ['GMAIL_USER', GMAIL_USER],
  ['GMAIL_APP_PASSWORD', GMAIL_APP_PASSWORD],
  ['RECIPIENT_EMAIL', RECIPIENT],
].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error('Missing GitHub secrets: ' + missing.join(', '));
  process.exit(1);
}

const PAY_DAY = 24;
const PRIOR_CYCLES = 3;
const ALERT_RATIO = 1.4;
const ALERT_MIN_DIFF = 20;

// ---------- Supabase ----------
async function fetchAll(table, order) {
  const rows = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=${order}`, {
      headers: {
        apikey: SERVICE_KEY,
                ...(SERVICE_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SERVICE_KEY}` } : {}),
        'Range-Unit': 'items',
        Range: `${from}-${from + size - 1}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase ${table} failed: ${res.status} ${await res.text()}`);
    const part = await res.json();
    rows.push(...part);
    if (part.length < size) break;
  }
  return rows;
}

// ---------- Spending groups (same rules as the ledger page) ----------
const SPEND_GROUPS = [
  { name: 'Bank charges', words: ['charge', 'charges', 'chg', 'fee', 'commission', 'imtt', 'tax', 'levy'], patterns: [/^ATM$/i] },
  { name: 'Subscriptions', words: ['apple.com', 'icloud', 'anthropic', 'claude', 'openai', 'chatgpt', 'google', 'youtube', 'netflix', 'spotify', 'microsoft', 'canva'] },
  { name: 'Fast food', words: ['chicken inn', 'pizza inn', 'creamy inn', 'chicken slice', 'chicken hut', 'galitos', 'nandos', 'nando', 'kfc', 'barcelos', 'steers', 'hungry lion', 'mambos', 'debonairs', 'wimpy', 'roco mamas', 'simbisa', 'fast food', 'takeaway', 'take away'] },
  { name: 'Groceries', words: ['ok zimbabwe', 'ok mart', 'ok supermarket', 'pick n pay', 'tm pick', 'spar', 'food lover', 'food lovers', 'bon marche', 'choppies', 'n richards', 'gain cash', 'supermarket', 'grocer', 'groceries', 'butcher', 'bakery'] },
  { name: 'Transport & fuel', words: ['zupco', 'fuel', 'zuva', 'puma', 'engen', 'redan', 'sakunda', 'totalenergies', 'uber', 'indrive', 'vaya', 'toll', 'zinara', 'taxi', 'kombi', 'bus fare'] },
  { name: 'Airtime & data', words: ['airtime', 'bundle', 'bundles', 'econet', 'netone', 'telecel', 'data'] },
  { name: 'Utilities', words: ['zesa', 'zetdc', 'electricity', 'council', 'water', 'liquid', 'zol', 'dstv', 'gotv', 'starlink', 'internet'] },
  { name: 'Rent & housing', words: ['rent', 'landlord'] },
  { name: 'Health', words: ['pharmacy', 'clinic', 'hospital', 'medical', 'cimas', 'psmas', 'doctor', 'dental', 'medicine'] },
  { name: 'Education', words: ['school', 'tuition', 'university', 'college'] },
  { name: 'Church & giving', words: ['church', 'tithe', 'offering', 'donation'] },
  { name: 'Loans & debt', words: ['loan'] },
  { name: 'Send money', words: ['sent to', 'send money', 'money transfer', 'zipit', 'mukuru', 'worldremit', 'world remit', 'western union', 'mama money'] },
  { name: 'Card swipes (shop not named)', words: ['cbz bank', 'fbc bank', 'ecobank', 'central africa building society', 'cabs', 'nmb bank', 'zb bank', 'steward bank', 'first capital bank', 'bancabc', 'agribank', 'posb'] },
  { name: 'Cash withdrawals', words: ['cash out', 'cashout', 'atm'] },
  { name: 'Transfers', words: ['bank to wallet', 'wallet to bank', 'ecocash', 'own account'], patterns: [/^\d{12}\/62$/], notSpending: true },
  { name: 'Other', words: [] },
];
const NOT_SPENDING = new Set(SPEND_GROUPS.filter(g => g.notSpending).map(g => g.name));
const GROUP_PATTERNS = SPEND_GROUPS.map(g => ({
  name: g.name,
  patterns: g.words
    .map(w => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'))
    .concat(g.patterns || []),
}));

let learned = new Map();
function buildLearned(rows) {
  learned = new Map();
  // rows are newest first, so the latest manual correction wins
  rows.forEach(r => {
    const key = (r.category || '').trim().toLowerCase();
    if (r.spend_group && !learned.has(key)) learned.set(key, r.spend_group);
  });
}
function groupFor(r) {
  if (r.spend_group) return r.spend_group;
  const l = learned.get((r.category || '').trim().toLowerCase());
  if (l) return l;
  const text = `${r.category || ''} ${r.note || ''}`.trim();
  const hit = GROUP_PATTERNS.find(g => g.patterns.some(p => p.test(text)));
  return hit ? hit.name : 'Other';
}
const countsAsMoney = r => !NOT_SPENDING.has(groupFor(r));

// ---------- Pay cycles (24th to 23rd) ----------
function todayInHarare() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Harare', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts; // YYYY-MM-DD
}
function cycleKeyForDate(dateStr) {
  const [yy, mm, dd] = dateStr.split('-').map(Number);
  let y = yy, m = mm;
  if (dd < PAY_DAY) { m -= 1; if (m < 1) { m = 12; y -= 1; } }
  return `${y}-${String(m).padStart(2, '0')}`;
}
function previousCycleKey(key) {
  let [y, m] = key.split('-').map(Number);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
const utc = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
function dayOfCycle(iso) {
  const [y, m] = cycleKeyForDate(iso).split('-').map(Number);
  return Math.round((utc(iso) - Date.UTC(y, m - 1, PAY_DAY)) / 86400000) + 1;
}
function daysToNextPayday(iso) {
  const [y, m] = cycleKeyForDate(iso).split('-').map(Number);
  const next = Date.UTC(y, m, PAY_DAY); // month index m = next month
  return Math.round((next - utc(iso)) / 86400000);
}

// ---------- Helpers ----------
const sum = xs => xs.reduce((s, x) => s + x, 0);
const avg = xs => (xs.length ? sum(xs) / xs.length : null);
const fmt = n => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Main ----------
async function main() {
  const [transactions, goals, debts] = await Promise.all([
    fetchAll('transactions', 'occurred_on.desc,id.desc'),
    fetchAll('goals', 'created_at.asc'),
    fetchAll('debts', 'created_at.asc'),
  ]);
  buildLearned(transactions);

  const today = todayInHarare();
  const curKey = cycleKeyForDate(today);
  const day = dayOfCycle(today);

  const money = transactions.filter(countsAsMoney);
  const cur = money.filter(r => cycleKeyForDate(r.occurred_on) === curKey);
  const income = sum(cur.filter(r => r.type === 'income').map(r => Number(r.amount)));
  const spent = sum(cur.filter(r => r.type === 'expense').map(r => Number(r.amount)));
  const net = income - spent;
  const rate = income > 0 ? Math.round((net / income) * 100) : 0;

  // Spending rows with their cycle day
  const spend = money
    .filter(r => r.type === 'expense')
    .map(r => ({ key: cycleKeyForDate(r.occurred_on), day: dayOfCycle(r.occurred_on), group: groupFor(r), amount: Number(r.amount) }));

  // Earlier cycles that actually have data
  const withData = new Set(transactions.map(r => cycleKeyForDate(r.occurred_on)));
  const priorKeys = [];
  let k = curKey;
  for (let i = 0; i < PRIOR_CYCLES; i++) {
    k = previousCycleKey(k);
    if (withData.has(k)) priorKeys.push(k);
  }
  const spentBy = (key, group) => sum(spend.filter(s => s.key === key && s.day <= day && (!group || s.group === group)).map(s => s.amount));

  const usual = priorKeys.length ? avg(priorKeys.map(key => spentBy(key))) : null;

  // Top groups this cycle
  const byGroup = new Map();
  spend.filter(s => s.key === curKey).forEach(s => byGroup.set(s.group, (byGroup.get(s.group) || 0) + s.amount));
  const topGroups = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);

  // Groups running well above usual
  const alerts = [];
  if (priorKeys.length) {
    [...byGroup.keys()].forEach(group => {
      const now = spentBy(curKey, group);
      const u = avg(priorKeys.map(key => spentBy(key, group)));
      if (u > 0 && now >= u * ALERT_RATIO && now - u >= ALERT_MIN_DIFF) {
        alerts.push({ group, now, usual: u, pct: Math.round((now / u - 1) * 100) });
      }
    });
    alerts.sort((a, b) => (b.now - b.usual) - (a.now - a.usual));
  }

  // Reflection questions, picked from the numbers (max 3)
  const questions = [];
  if (alerts[0]) questions.push(`${alerts[0].group} is ${alerts[0].pct}% above your usual for this point in the cycle (${fmt(alerts[0].now)} vs ${fmt(alerts[0].usual)}). What happened there, and is it a one-off?`);
  if (net < 0) questions.push(`You have spent ${fmt(Math.abs(net))} more than came in this cycle. What is one spend that could wait?`);
  else if (topGroups[0]) questions.push(`Your biggest spend so far is ${topGroups[0][0]} at ${fmt(topGroups[0][1])}. Was that what you planned?`);
  const behind = goals
    .filter(g => Number(g.target_amount) > 0 && Number(g.current_amount) < Number(g.target_amount))
    .sort((a, b) => (a.current_amount / a.target_amount) - (b.current_amount / b.target_amount))[0];
  if (behind && questions.length < 3) questions.push(`"${behind.title}" is ${Math.round((behind.current_amount / behind.target_amount) * 100)}% there. Is there anything you can put toward it this week?`);
  if (questions.length < 3) questions.push('Is there anything from the past few days you have not logged yet?');

  // ---------- Build the email ----------
  const paceLine = usual === null
    ? `Day ${day} of this pay cycle: you have spent <strong>${fmt(spent)}</strong> so far.`
    : `Day ${day} of this pay cycle: you have spent <strong>${fmt(spent)}</strong>. By this point, your last ${priorKeys.length} cycle${priorKeys.length === 1 ? '' : 's'} had usually spent <strong>${fmt(usual)}</strong> (${spent > usual ? fmt(spent - usual) + ' more' : fmt(usual - spent) + ' less'} than usual).`;

  const goalsHtml = goals.length
    ? goals.map(g => {
        const pct = Number(g.target_amount) > 0 ? Math.min(100, Math.round((g.current_amount / g.target_amount) * 100)) : 0;
        return `<li>${esc(g.title)}: ${fmt(g.current_amount)} of ${fmt(g.target_amount)} (${pct}%)${g.target_date ? ', target ' + esc(g.target_date) : ''}</li>`;
      }).join('')
    : '<li>No goals logged yet.</li>';

  const debtsHtml = debts.length
    ? debts.map(d => `<li>${esc(d.title)}: ${fmt(d.remaining_amount)} left of ${fmt(d.total_amount)}${d.due_date ? ', due ' + esc(d.due_date) : ''}</li>`).join('')
    : '<li>No debts logged.</li>';

  const topHtml = topGroups.length
    ? topGroups.map(([g, a]) => `<li>${esc(g)}: ${fmt(a)}</li>`).join('')
    : '<li>Nothing spent yet this cycle.</li>';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2937;">
    <h2 style="margin-bottom:4px;">Your week in review</h2>
    <p style="margin-top:0;color:#6b7280;">${esc(today)} · ${daysToNextPayday(today)} days to payday</p>
    <p style="line-height:1.6;">Hey, the week just ended. Here is where things stand. Take a minute to log anything from the past few days you have not captured yet.</p>

    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:6px 0;">Income this cycle</td><td style="text-align:right;">${fmt(income)}</td></tr>
      <tr><td style="padding:6px 0;">Spending this cycle</td><td style="text-align:right;">${fmt(spent)}</td></tr>
      <tr><td style="padding:6px 0;"><strong>Net</strong></td><td style="text-align:right;"><strong>${net >= 0 ? '+' : ''}${fmt(net)}</strong></td></tr>
      <tr><td style="padding:6px 0;">Savings rate</td><td style="text-align:right;">${rate}%</td></tr>
    </table>

    <p style="line-height:1.6;">${paceLine}</p>

    <h3>Where the money went</h3>
    <ul style="line-height:1.7;">${topHtml}</ul>

    <h3>Savings and investments</h3>
    <ul style="line-height:1.7;">${goalsHtml}</ul>

    <h3>Debts</h3>
    <ul style="line-height:1.7;">${debtsHtml}</ul>

    <h3>Think about this week</h3>
    <ol style="line-height:1.7;">${questions.map(q => `<li>${esc(q)}</li>`).join('')}</ol>

    <p style="color:#6b7280;font-size:12px;">Sent automatically from your ledger. Reply to this email with any thoughts.</p>
  </div>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `"Mukoma Bob's Ledger" <${GMAIL_USER}>`,
    to: RECIPIENT,
    subject: `Your week in review, ${net >= 0 ? '+' : ''}${fmt(net)} net`,
    html,
  });

  console.log('Email sent to', RECIPIENT);
}

main().catch(err => {
  console.error('Weekly summary failed:', err.message);
  process.exit(1);
});
