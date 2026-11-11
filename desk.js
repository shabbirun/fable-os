// Fable OS desk: the audit log, loud failures, the approval queue, leads, vault skills and model routing.
// Everything an agent wants to do that leaves this Mac passes through here, so the rules live in code, not in a prompt.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFile } = require('child_process');

// ---- pure helpers (tested in test.js) ----
// A gws call is a read only if its method is one of Google's read verbs. Everything else waits for a click.
const READ = /^(list\w*|get\w*|search\w*|batchGet\w*|query|\+triage|\+read)$/;
const isRead = p => p.length > 1 && (p[0] === 'schema' || READ.test(p[p.length - 1]));

// Auto routing: Sonnet answers quick questions, Fable takes the long jobs.
const LONG = /\b(overnight|research|deep[- ]dive|audit|compile|comprehensive|thorough(ly)?|in[- ]depth|long job|take your time|find (me )?\d+|\d+ (leads|prospects|companies|accounts))\b/i;
const route = (text, skill) => skill ? { engine: 'fable', why: 'skill run' }
  : LONG.test(text) || text.length > 700 ? { engine: 'fable', why: 'long job' } : { engine: 'claude', why: 'quick question' };

function csv(src) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(Boolean)) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...rest] = rows;
  return head ? rest.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] || '']))) : [];
}

// Open-Meteo's answer as a few plain lines the agent can read out. Missing numbers show as "?", never a guess.
const WMO = { 0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };
function forecast(place, w, air) {
  const c = w?.current || {}, d = w?.daily || {}, a = air?.current || {}, r = n => Number.isFinite(n) ? Math.round(n) : '?', sky = k => WMO[k] || 'conditions unknown';
  const out = [`Live weather for ${place} (Open-Meteo${c.time ? ', as of ' + String(c.time).replace('T', ' ') + ' local time' : ''})`];
  if (c.temperature_2m != null) out.push(`Now: ${r(c.temperature_2m)}°C, feels like ${r(c.apparent_temperature)}°C, ${sky(c.weather_code)}, humidity ${r(c.relative_humidity_2m)}%, wind ${r(c.wind_speed_10m)} km/h`);
  if (a.us_aqi != null) out.push(`Air quality now: US AQI ${r(a.us_aqi)}, PM2.5 ${r(a.pm2_5)} µg/m³`);
  (d.time || []).forEach((t, i) => out.push(`${['Today', 'Tomorrow'][i] || t}: ${sky(d.weather_code?.[i])}, ${r(d.temperature_2m_min?.[i])} to ${r(d.temperature_2m_max?.[i])}°C, rain chance ${r(d.precipitation_probability_max?.[i])}%`));
  return out.join('\n');
}

const day = t => new Date(t).toLocaleDateString('en-CA'); // local YYYY-MM-DD
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

module.exports = ({ ROOT, VAULT, emit, pulse }) => {
  const DATA = path.join(ROOT, 'data'); fs.mkdirSync(DATA, { recursive: true });
  const F = n => path.join(DATA, n);
  const save = (n, o) => fs.writeFileSync(F(n), JSON.stringify(o, null, 1));
  const changed = () => emit('desk', { desk: snapshot() });

  // ---- one audit log: every agent action, approval and failure, append-only ----
  const cost = {}; // day -> { usd, runs, tokens }
  // Tokens per model, in total and per session. Runs logged before the in/cached/out split only have a single number.
  const total = {}, bySession = {}; // model -> { runs, in, cached, out, tokens, usd } ; session -> { last, models: { model -> same } }
  const addCost = e => {
    const c = cost[day(e.t)] ??= { usd: 0, runs: 0, tokens: 0 }; c.usd += e.usd || 0; c.runs++; c.tokens += e.tokens || 0;
    const s = bySession[e.session] ??= { last: 0, models: {} }; s.last = Math.max(s.last, e.t);
    for (const m of [total, s.models]) {
      const u = m[e.model] ??= { runs: 0, in: 0, cached: 0, out: 0, tokens: 0, usd: 0 };
      u.runs++; u.in += e.tok?.in || 0; u.cached += e.tok?.cached || 0; u.out += e.tok?.out || 0; u.tokens += e.tokens || 0; u.usd += e.usd || 0;
    }
  };
  const usage = () => ({ total, sessions: Object.entries(bySession).map(([session, s]) => ({ session, ...s })).sort((a, b) => b.last - a.last) });
  try { for (const l of fs.readFileSync(F('audit.jsonl'), 'utf8').split('\n')) if (l.includes('"run.end"')) try { addCost(JSON.parse(l)); } catch {} } catch {}
  function audit(kind, d = {}) {
    const e = { t: Date.now(), kind, ...d };
    fs.appendFileSync(F('audit.jsonl'), JSON.stringify(e) + '\n');
    if (kind === 'run.end') addCost(e);
    emit('audit', { entry: e });
    return e;
  }
  function tail(n = 400) {
    try {
      const fd = fs.openSync(F('audit.jsonl'), 'r'), size = fs.fstatSync(fd).size, len = Math.min(size, 6e5), b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd);
      return b.toString().split('\n').slice(len < size ? 1 : 0).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-n);
    } catch { return []; }
  }

  // ---- loud failures: a red banner in the app, the log, and a macOS notification with a sound ----
  let alerts = load(F('alerts.json'), []);
  const notify = (title, text) => execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Basso"', '-e', 'end run', title, text], () => {});
  function fail(what, detail = '', session) {
    detail = String(detail).trim().slice(0, 600);
    const a = { id: crypto.randomUUID(), t: Date.now(), what, detail, session };
    alerts.push(a); alerts = alerts.slice(-20); save('alerts.json', alerts);
    audit('fail', { what, detail, session });
    pulse('alert', `${what}${detail ? ': ' + detail.split('\n')[0].slice(0, 100) : ''}`);
    notify('Fable OS: ' + what, detail.slice(0, 180) || 'Open Fable OS to see what happened.');
    changed();
  }
  function dismiss(id) { alerts = id ? alerts.filter(a => a.id !== id) : []; save('alerts.json', alerts); changed(); }

  // ---- gws runs here, in the server, never in an agent's shell ----
  const gwsRun = args => new Promise(r => execFile('gws', args, { maxBuffer: 5e7, timeout: 120e3 }, (e, out, err) => {
    const text = (out || '').replace(/^Using keyring backend.*\n/, '').trim();
    r({ ok: !e, out: e ? (text + '\n' + (err || e.message)).trim() : text });
  }));

  // ---- approval queue ----
  // Persistent items (email, proposal, gws write) wait until clicked, across restarts; the server itself executes them.
  // Blocking asks (hands on the Mac, a shell command) hold the agent's tool call open until clicked, and die with the run.
  let queue = load(F('queue.json'), []);
  const asks = new Map(); // id -> { item, done }
  const saveQ = () => { const w = queue.filter(i => i.status === 'waiting'); queue = [...queue.filter(i => i.status !== 'waiting').slice(-40), ...w]; save('queue.json', queue); changed(); };

  function enqueue(session, kind, title, detail, payload) {
    const item = { id: crypto.randomUUID(), kind, title: title.slice(0, 160), detail: String(detail || '').slice(0, 20000), payload, session, created: Date.now(), status: 'waiting' };
    queue.push(item); saveQ();
    audit('approval.queued', { session, id: item.id, what: kind, title: item.title });
    pulse('approval', `Waiting on you: ${item.title}`);
    return item;
  }
  function ask(session, kind, title, detail, ms = 600e3) {
    return new Promise(res => {
      const item = { id: crypto.randomUUID(), kind, title: title.slice(0, 160), detail: String(detail || '').slice(0, 4000), session, created: Date.now(), status: 'waiting', blocking: true };
      const done = ok => { if (!asks.delete(item.id)) return; clearTimeout(timer); audit(ok ? 'approval.approved' : 'approval.rejected', { session, id: item.id, what: kind, title: item.title, by: ok === null ? 'timeout' : 'click' }); changed(); res(!!ok); };
      const timer = setTimeout(() => done(null), ms);
      asks.set(item.id, { item, done });
      audit('approval.queued', { session, id: item.id, what: kind, title: item.title });
      pulse('approval', `Waiting on you: ${item.title}`); changed();
    });
  }
  async function decide(id, approve, edits) {
    if (asks.has(id)) { asks.get(id).done(!!approve); return { ok: true }; }
    const item = queue.find(i => i.id === id);
    if (!item || item.status !== 'waiting') return { error: 'That is no longer waiting.' };
    if (!approve) { item.status = 'rejected'; item.decided = Date.now(); saveQ(); audit('approval.rejected', { session: item.session, id, what: item.kind, title: item.title, by: 'click' }); return { ok: true, item }; }
    const p = item.payload;
    if (edits && item.kind !== 'gws') for (const k of ['to', 'subject', 'body', 'cc']) if (typeof edits[k] === 'string') p[k] = edits[k];
    item.status = 'sending'; saveQ();
    audit('approval.approved', { session: item.session, id, what: item.kind, title: item.title, by: 'click' });
    const opt = (k, v) => v ? [`--${k}=${v}`] : [];
    const args = item.kind === 'gws' ? p.args
      : p.replyTo ? ['gmail', '+reply', `--message-id=${p.replyTo}`, `--body=${p.body}`, ...opt('to', p.to), ...opt('cc', p.cc)]
      : ['gmail', '+send', `--to=${p.to}`, `--subject=${p.subject}`, `--body=${p.body}`, ...opt('cc', p.cc)];
    const r = await gwsRun(process.env.NOOR_DRY_RUN === '1' && item.kind !== 'gws' ? [...args, '--dry-run'] : args);
    item.status = r.ok ? 'done' : 'failed'; item.decided = Date.now(); item.result = r.out.slice(0, 600); saveQ();
    audit('approval.executed', { session: item.session, id, what: item.kind, title: item.title, ok: r.ok, result: item.result.slice(0, 200) });
    if (r.ok) pulse('approval', `Done: ${item.title}`); else fail(`Approved action failed: ${item.title}`, r.out, item.session);
    if (r.ok && p.lead) { const l = leads.find(x => x.id === slug(p.lead)); if (l && item.kind === 'proposal') { l.status = 'proposal'; l.updated = Date.now(); save('leads.json', leads); changed(); } }
    return { ok: r.ok, item, error: r.ok ? undefined : item.result };
  }

  // Hands on the Mac (click, type, open) need one grant per run.
  const hands = new Map(); // session -> true | false | Promise
  function allowHands(session, what) {
    if (!hands.has(session)) hands.set(session, ask(session, 'hands', 'Let Fable OS use the mouse and keyboard for this run', `First action: ${what}`).then(ok => (hands.set(session, ok), ok)));
    return hands.get(session);
  }
  function endRun(session) { hands.delete(session); for (const { item, done } of [...asks.values()]) if (item.session === session) done(false); }

  // ---- what agents can call (through ostools.js) ----
  const agent = {
    async gws(session, a) {
      const p = String(a.path || '').trim().split(/\s+/);
      if (!p.every(t => /^\+?[\w.-]+$/.test(t)) || p.length < 2) throw new Error('path must look like "gmail users messages list" or "schema gmail.users.messages.list".');
      if (/^\+(send|reply|reply-all|forward)$/.test(p[p.length - 1])) throw new Error('Use the draft_email tool for email; it goes to the approval queue.');
      const args = [...p, ...(a.params ? ['--params', JSON.stringify(a.params)] : []), ...(a.body ? ['--json', JSON.stringify(a.body)] : [])];
      if (!isRead(p)) {
        const item = enqueue(session, 'gws', `Google change: ${p.join(' ')}`, JSON.stringify({ params: a.params, body: a.body }, null, 2), { args });
        return `Not run. This changes something in Google, so it is now in Shabbir's approval queue (${item.id.slice(0, 8)}) and runs only when he clicks Approve. Tell him it is waiting. Do not retry or look for another route.`;
      }
      const r = await gwsRun(args);
      if (!r.ok) throw new Error(r.out.slice(0, 4000));
      return r.out.length > 60000 ? r.out.slice(0, 60000) + '\n[truncated: narrow the request with params such as maxResults, fields or format]' : r.out;
    },
    draft(session, a) {
      const p = { to: String(a.to || '').trim(), subject: String(a.subject || '').trim(), body: String(a.body || ''), cc: String(a.cc || '').trim(), replyTo: String(a.reply_to_message_id || '').trim(), lead: String(a.lead || '').trim() };
      if (!p.body.trim()) throw new Error('body is required');
      if (!p.replyTo && (!/\S+@\S+/.test(p.to) || !p.subject)) throw new Error('to and subject are required unless reply_to_message_id is given');
      const kind = a.kind === 'proposal' ? 'proposal' : 'email';
      const item = enqueue(session, kind, `${kind === 'proposal' ? 'Proposal' : 'Email'} ${p.replyTo && !p.to ? 'reply' : 'to ' + p.to}: ${p.subject || '(reply in thread)'}`, p.body, p);
      return `Queued as a draft (${item.id.slice(0, 8)}). Nothing has been sent. It goes only if Shabbir clicks Send in the Waiting on you panel, where he can also edit it. Tell him it is waiting.`;
    },
    lead(session, a) {
      const name = String(a.name || '').trim(); if (!name) throw new Error('name is required');
      const id = slug(name + ' ' + (a.company || '')); let l = leads.find(x => x.id === id);
      if (!l) leads.push(l = { id, created: Date.now(), status: 'new' });
      for (const k of ['name', 'company', 'segment', 'fit', 'source', 'contact', 'notes']) if (a[k]) l[k] = String(a[k]).slice(0, 1000);
      if (['new', 'contacted', 'proposal', 'won', 'lost'].includes(a.status)) l.status = a.status;
      if (Number.isFinite(+a.value_usd) && a.value_usd !== '' && a.value_usd != null) l.value_usd = +a.value_usd;
      l.updated = Date.now(); save('leads.json', leads);
      audit('lead', { session, id, name: l.name, status: l.status }); pulse('lead', `Lead saved: ${l.name}${l.company ? ', ' + l.company : ''}`); changed();
      return `Lead saved: ${l.name} (${l.status}). ${leads.length} leads on the board.`;
    },
    async shell(session, a) {
      const cmd = String(a.command || '').trim(); if (!cmd) throw new Error('command is required');
      if (!await ask(session, 'shell', `Run a command: ${cmd.slice(0, 110)}`, `${a.why ? a.why + '\n\n' : ''}$ ${cmd}\n\nRuns in ${VAULT}`)) throw new Error('Shabbir did not approve this command. Do not retry it; tell him what you needed it for.');
      return new Promise(res => execFile('/bin/zsh', ['-lc', cmd], { cwd: VAULT, timeout: 600e3, maxBuffer: 5e7 }, (e, out, err) => {
        const text = ((out || '') + (err ? '\n' + err : '')).trim().slice(-20000);
        audit('shell', { session, command: cmd.slice(0, 300), ok: !e });
        res(`exit ${e ? (e.code ?? 'killed') : 0}\n${text}`);
      }));
    },
    // Live weather from Open-Meteo (no key). Only the city name, then its coordinates, leave this Mac.
    // The home city is kept in data/config.json, as the place name Open-Meteo resolved, not the agent's own wording.
    async weather(session, a) {
      const meteo = async u => { const r = await fetch(u, { signal: AbortSignal.timeout(15e3) }).catch(() => null); if (!r?.ok) throw new Error('Open-Meteo did not answer. Tell him the live forecast is unavailable right now; do not pass off typical numbers as a forecast.'); return r.json(); };
      const city = String(a.city || '').trim().slice(0, 80), keep = !!city && (a.home === true || a.home === 'true');
      let at = load(F('config.json'), {}).home;
      if (city) {
        const g = (await meteo('https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' + encodeURIComponent(city))).results?.[0];
        if (!g) throw new Error(`Open-Meteo knows no place called "${city}". Check the spelling or ask him for the nearest city.`);
        at = { place: [...new Set([g.name, g.admin1, g.country].filter(Boolean))].join(', ').replace(/[^\p{L}\p{N} ,.'()-]/gu, '').slice(0, 80), lat: +g.latitude, lon: +g.longitude };
      }
      if (!Number.isFinite(at?.lat) || !Number.isFinite(at?.lon)) throw new Error('No city given and no home city on file. Ask him which city, then call weather with it, and with home true if he says he lives there.');
      if (keep) { save('config.json', { ...load(F('config.json'), {}), home: at }); audit('home', { session, place: at.place }); pulse('system', `Home city saved: ${at.place}`); }
      const q = `latitude=${at.lat}&longitude=${at.lon}&timezone=auto`;
      const [w, air] = await Promise.all([
        meteo(`https://api.open-meteo.com/v1/forecast?${q}&forecast_days=3&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`),
        meteo(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=us_aqi,pm2_5`).catch(() => null),
      ]);
      return forecast(String(at.place || 'his home city').slice(0, 80), w, air) + (keep ? `\nSaved ${at.place} as his home city; it is used from now on when no city is given.` : '');
    },
    async hands(session, what) { if (!await allowHands(session, what)) throw new Error('Shabbir has not approved mouse and keyboard control for this run. Carry on without it and tell him what you would have done.'); },
  };

  // ---- leads and the business panel ----
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  let leads = load(F('leads.json'), []);
  function business() {
    const now = Date.now(), waiting = queue.filter(i => i.status === 'waiting');
    let pipeline = [];
    // Set "pipeline": false in data/config.json to keep the real accounts in the vault off the screen (demos, recordings).
    if (load(F('config.json'), {}).pipeline !== false) try { pipeline = csv(fs.readFileSync(path.join(VAULT, 'strategy', '20k-mrr-pipeline.csv'), 'utf8')).map(r => ({ account: r.account, segment: r.segment, status: r.status, next: r.next_action, fee: r.recurring_fee_proposed_usd })); } catch {}
    const days = [...Array(7)].map((_, i) => { const d = day(now - (6 - i) * 864e5); return { d, ...(cost[d] || { usd: 0, runs: 0, tokens: 0 }) }; });
    return {
      leads: { total: leads.length, week: leads.filter(l => now - l.created < 7 * 864e5).length, recent: [...leads].sort((a, b) => b.updated - a.updated).slice(0, 8) },
      proposals: waiting.filter(i => i.kind === 'proposal').length, drafts: waiting.filter(i => i.kind !== 'proposal').length,
      pipeline, days, today: days[6],
    };
  }

  // ---- skills: whatever is in the vault and in the user's global skills folder ----
  function skills() {
    const out = [];
    for (const [scope, dir] of [['vault', path.join(VAULT, '.claude', 'skills')], ['global', path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills')]]) {
      let names; try { names = fs.readdirSync(dir).sort(); } catch { continue; }
      for (const n of names) {
        const file = n.endsWith('.md') ? path.join(dir, n) : path.join(dir, n, 'SKILL.md'), base = n.replace(/\.md$/, '');
        let head; try { head = fs.readFileSync(file, 'utf8').slice(0, 4000); } catch { continue; }
        const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
        const get = k => (fm.match(new RegExp(`^${k}:[ \\t]*(.*(?:\\n[ \\t]+.*)*)`, 'm'))?.[1] || '').replace(/^[>|][-+]?\s*/, '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
        out.push({ id: `${scope}:${base}`, name: get('name') || base, description: get('description').slice(0, 260), scope, file });
      }
    }
    return out;
  }
  const ENG = ['auto', 'claude', 'fable', 'codex'], EFF = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
  function config() {
    const c = load(F('config.json'), {}), all = skills(), ids = new Set(all.map(s => s.id));
    const b = (c.buttons || []).filter(x => ids.has(x.skill)).slice(0, 5);
    for (const s of all) if (b.length < 5 && !b.some(x => x.skill === s.id)) b.push({ skill: s.id, engine: 'auto', effort: 'auto' });
    return { buttons: b };
  }
  function setConfig(c) {
    const ids = new Set(skills().map(s => s.id));
    const buttons = (c.buttons || []).filter(b => ids.has(b.skill)).slice(0, 5).map(b => ({ skill: b.skill, engine: ENG.includes(b.engine) ? b.engine : 'auto', effort: EFF.includes(b.effort) ? b.effort : 'auto' }));
    save('config.json', { ...load(F('config.json'), {}), buttons }); return { buttons };
  }

  const snapshot = () => ({ queue: [...[...asks.values()].map(a => a.item), ...queue.filter(i => i.status === 'waiting' || i.status === 'sending')].sort((a, b) => a.created - b.created), alerts, business: business() });
  const home = () => String(load(F('config.json'), {}).home?.place || '').slice(0, 80); // '' until he has said where he lives
  return { usage, audit, tail, fail, dismiss, decide, endRun, agent, skills, config, setConfig, snapshot, changed, EFF, home };
};
Object.assign(module.exports, { isRead, route, csv, forecast });
