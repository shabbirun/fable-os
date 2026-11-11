// Fable OS self-improvement: read every session, suggest changes to Fable OS's own code, implement the ones you pick.
// The agent only ever edits a staged copy in data/improve/<id>/. The live files change when you click Apply,
// after the staged copy has passed its checks, and the previous files are kept in data/backups/ for Undo.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const SRC = ['server.js', 'desk.js', 'ostools.js', 'mcp.js', 'improve.js', 'test.js', 'public/index.html'];
const NOTES = ['sessions.md', 'audit.md', 'suggestions.json']; // working files in the staged copy, never applied
const SENSITIVE = ['desk.js', 'ostools.js', 'test.js', 'improve.js']; // approvals, hands gate, tests, this file
const RULES = `Rules for any change:
- Never weaken the approval queue, the read/write split for Google, the mouse-and-keyboard gate, the no-shell rule, the localhost guard or the audit log. Do not add ways for an agent to send, post, pay or delete without the user's click.
- Zero dependencies: plain Node and one HTML file. Match the existing style and keep changes small.
- Keep test.js passing, and extend it when you change behaviour it should cover. You cannot run commands; the system runs the checks after you finish.
- Only touch files in this folder.`;

module.exports = ({ ROOT, model, home, emit, audit, fail, sessionsDir }) => {
  const DIR = path.join(ROOT, 'data', 'improve'), BACK = path.join(ROOT, 'data', 'backups'), FILE = path.join(ROOT, 'data', 'improve.json');
  let st = (() => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { status: 'idle' }; } })();
  if (st.status === 'analysing' || st.status === 'implementing') st = { ...st, status: 'failed', error: 'Fable OS restarted while this was running.' };
  let child = null;
  const stage = () => path.join(DIR, st.id);
  const lastBackup = () => { try { return fs.readdirSync(BACK).sort().pop(); } catch { return undefined; } };
  const view = () => ({ ...st, thread: undefined, undo: lastBackup() });
  const set = o => { Object.assign(st, o); fs.writeFileSync(FILE, JSON.stringify(st)); emit('improve', { improve: view() }); };
  const sh = (cmd, args, cwd) => new Promise(r => execFile(cmd, args, { cwd, timeout: 90e3, maxBuffer: 2e7 }, (e, out, err) => r({ ok: !e, code: e?.code, out: ((out || '') + (err || '')).trim() })));

  // Every conversation, newest first, trimmed so the whole thing stays readable in one pass.
  function digest() {
    const all = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { return null; } })
      .filter(s => s?.messages?.length).sort((a, b) => b.updated - a.updated);
    let out = `# Every Fable OS session (${all.length}), newest first\n`;
    for (const s of all) {
      let t = `\n## ${s.title || '(untitled)'} — ${new Date(s.updated).toISOString().slice(0, 16)}\n`;
      for (const m of s.messages) t += m.role === 'user' ? `\nUSER: ${m.text.slice(0, 1500)}\n` : m.role === 'note' ? `\nNOTE: ${m.text}\n`
        : `\nFABLE OS (${m.engine}${m.failed ? ', RUN FAILED' : ''}${m.ms ? ', ' + Math.round(m.ms / 1000) + 's' : ''}):${m.tools?.length ? `\n  tools: ${m.tools.slice(0, 20).join(' | ').slice(0, 900)}` : ''}${m.spoken?.length ? `\n  spoken: ${m.spoken.join(' / ').slice(0, 400)}` : ''}\n  ${(m.text || '').slice(0, 1800)}\n`;
      if (out.length + t.length > 180000) { out += '\n[older sessions left out for length]\n'; break; }
      out += t;
    }
    return { text: out, count: all.length };
  }
  function auditNotes() {
    let lines = []; try { lines = fs.readFileSync(path.join(ROOT, 'data', 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
    const bad = lines.filter(e => e.kind === 'fail' || e.ok === false || e.kind === 'approval.rejected').slice(-80);
    return `# Failures, refused approvals and failed actions from the audit log (${bad.length})\n\n` + bad.map(e => `- ${new Date(e.t).toISOString().slice(0, 16)} ${e.kind}: ${e.what || e.title || e.model || ''} ${String(e.detail || e.result || e.by || '').replace(/\n/g, ' ').slice(0, 300)}`).join('\n');
  }

  // One Claude Code run inside the staged copy: it can read and edit there, and nothing else.
  function agent(prompt, resume) {
    return new Promise(res => {
      const args = ['-p', prompt, '--model', model, '--effort', 'high', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--permission-mode', 'acceptEdits', '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit', 'Write', '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Task', ...(resume ? ['--resume', resume] : [])];
      const t0 = Date.now(), r = { text: '', thread: resume, bad: '' }; let buf = '', err = '';
      child = spawn('claude', args, { cwd: stage(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CONFIG_DIR: home } });
      if (child.pid) spawn('caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore' }).on('error', () => {});
      audit('run.start', { session: 'self-improve', engine: 'fable', model, effort: 'high', text: prompt.slice(0, 200) });
      child.stdout.on('data', d => {
        buf += d; const lines = buf.split('\n'); buf = lines.pop();
        for (const l of lines) {
          let ev; try { ev = JSON.parse(l); } catch { continue; }
          if (ev.session_id) r.thread = ev.session_id;
          if (ev.type === 'assistant') for (const c of ev.message?.content || []) {
            if (c.type === 'text') r.text = c.text;
            if (c.type === 'tool_use') { const step = `${c.name} ${String(c.input?.file_path || c.input?.pattern || '').replace(stage() + '/', '')}`.trim(); audit('tool', { session: 'self-improve', label: step }); set({ step }); }
          }
          if (ev.type === 'result') { const u = ev.usage || {}; r.usd = ev.total_cost_usd; r.tok = { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, out: u.output_tokens || 0 }; if (ev.is_error) r.bad = String(ev.result || ev.subtype || 'error'); else if (ev.result) r.text = ev.result; }
        }
      });
      child.stderr.on('data', d => { err = (err + d).slice(-1500); });
      child.on('error', e => { err += `Could not start claude: ${e.message}`; });
      child.on('close', code => {
        const stopped = child?.stopped; child = null; r.ok = code === 0 && !r.bad; r.stopped = stopped; if (!r.ok) r.bad ||= err.trim() || `exit code ${code}`;
        audit('run.end', { session: 'self-improve', engine: 'fable', model, ok: r.ok, stopped, code, ms: Date.now() - t0, usd: r.usd, tok: r.tok, tokens: r.tok ? r.tok.in + r.tok.cached + r.tok.out : undefined });
        set({ usd: (st.usd || 0) + (r.usd || 0), thread: r.thread }); res(r);
      });
    });
  }
  const broke = (what, r) => { if (r.stopped) return set({ status: 'idle', step: '' }); set({ status: 'failed', error: `${what}: ${r.bad}`.slice(0, 800), step: '' }); fail('Self-improvement run failed', `${what}\n${r.bad}`); };

  async function start() {
    if (child) return { error: 'Already working.' };
    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + crypto.randomUUID().slice(0, 4), d = digest();
    st = {}; set({ id, status: 'analysing', sessions: d.count, started: Date.now(), usd: 0, step: 'Reading your sessions' });
    for (const f of SRC) { fs.mkdirSync(path.dirname(path.join(stage(), f)), { recursive: true }); fs.copyFileSync(path.join(ROOT, f), path.join(stage(), f)); }
    fs.writeFileSync(path.join(stage(), 'sessions.md'), d.text); fs.writeFileSync(path.join(stage(), 'audit.md'), auditNotes());
    audit('improve', { step: 'started', id, sessions: d.count });
    (async () => {
      const r = await agent(`This folder is a copy of the source of Fable OS, a personal agentic OS (a local Node server plus one web page) that runs on its owner's Mac. sessions.md holds every conversation he has had with it; audit.md lists its failures and refused approvals.

Your job: work out how Fable OS itself should change so those conversations would have gone better. Read sessions.md and audit.md first, then the source. Look for where Fable OS failed him, misled him, made him repeat himself, was slow or confusing, or lacked something he clearly wanted. Ignore one-off test chatter.

Do not edit any source file yet. Write suggestions.json in this folder: a JSON array of at most 6 items, best first, each {"id":"s1","title":"short plain title","why":"what it changes for him, one or two sentences","evidence":"a short quote or specific moment from sessions.md or audit.md","files":["server.js"],"risk":"low|medium|high"}. Only suggest changes you could implement here in a few dozen lines each, and only ones the evidence supports. If nothing is worth changing, write [].

${RULES}`);
      if (!r.ok) return broke('Reading the sessions', r);
      let list; try { list = JSON.parse(fs.readFileSync(path.join(stage(), 'suggestions.json'), 'utf8')); } catch { try { list = JSON.parse(r.text.match(/\[[\s\S]*\]/)[0]); } catch {} }
      if (!Array.isArray(list)) return broke('Reading the sessions', { bad: 'It finished without a readable suggestions.json.' });
      list = list.slice(0, 6).map((s, i) => ({ id: String(s.id || 's' + (i + 1)), title: String(s.title || '').slice(0, 140), why: String(s.why || '').slice(0, 500), evidence: String(s.evidence || '').slice(0, 400), files: [].concat(s.files || []).map(String).slice(0, 6), risk: ['low', 'medium', 'high'].includes(s.risk) ? s.risk : 'medium' }));
      audit('improve', { step: 'suggested', id, count: list.length });
      set({ status: 'suggested', suggestions: list, step: '' });
    })();
    return { ok: true };
  }

  // Syntax of every script (including the page's inline one), then the staged test suite.
  async function check() {
    const out = []; let ok = true;
    const files = fs.readdirSync(stage(), { recursive: true }).map(String).filter(f => f.endsWith('.js'));
    const page = path.join(stage(), 'public', 'index.html'), tmp = path.join(stage(), '.page-script.js');
    try { const h = fs.readFileSync(page, 'utf8'); fs.writeFileSync(tmp, h.slice(h.indexOf('<script>') + 8, h.lastIndexOf('</script>'))); files.push('.page-script.js'); } catch { ok = false; out.push('public/index.html is missing or has no script.'); }
    for (const f of files) { const r = await sh(process.execPath, ['--check', f], stage()); if (!r.ok) { ok = false; out.push(`Syntax error in ${f === '.page-script.js' ? 'the script inside public/index.html' : f}:\n${r.out.slice(0, 1200)}`); } }
    fs.rmSync(tmp, { force: true });
    if (ok) { const r = await sh(process.execPath, ['test.js'], stage()); if (!r.ok || !/\bok\b/.test(r.out)) { ok = false; out.push(`node test.js failed:\n${r.out.slice(-2500)}`); } else out.push('Syntax checks and node test.js passed on the staged copy.'); }
    return { ok, out: out.join('\n\n') };
  }
  async function changes() {
    const files = fs.readdirSync(stage(), { recursive: true }).map(String).filter(f => !NOTES.includes(f) && !f.startsWith('.') && fs.statSync(path.join(stage(), f)).isFile());
    const changed = []; let diff = '';
    for (const f of files) {
      const live = path.join(ROOT, f), r = await sh('diff', ['-u', '--label', 'now/' + f, '--label', 'proposed/' + f, fs.existsSync(live) ? live : '/dev/null', path.join(stage(), f)]);
      if (r.code === 1) { changed.push(f); diff += r.out + '\n'; }
    }
    return { changed, diff: diff.slice(0, 400000), sensitive: changed.filter(f => SENSITIVE.includes(f)) };
  }

  async function implement(ids) {
    if (child || st.status !== 'suggested') return { error: 'Nothing to implement right now.' };
    const picked = (st.suggestions || []).filter(s => ids.includes(s.id)); if (!picked.length) return { error: 'Pick at least one suggestion.' };
    set({ status: 'implementing', picked: picked.map(s => s.id), step: 'Starting' });
    audit('improve', { step: 'implementing', id: st.id, picked: picked.map(s => s.title) });
    (async () => {
      let r = await agent(`Implement these suggestions now, by editing the files in this folder:\n${picked.map(s => `- ${s.id}: ${s.title} — ${s.why}`).join('\n')}\n\nLeave the other suggestions alone. ${RULES}\n\nFinish with a short plain summary for the owner: for each suggestion, what now behaves differently and anything he should check by hand.`, st.thread);
      if (!r.ok) return broke('Implementing', r);
      let c = await check();
      if (!c.ok) { // one chance to fix what the checks found
        set({ step: 'Fixing what the checks found' });
        r = await agent(`The checks on your changes failed. Fix the code (not by deleting or loosening tests that guard approvals) and end with the same kind of summary.\n\n${c.out}`, st.thread);
        if (!r.ok) return broke('Fixing the checks', r);
        c = await check();
      }
      const ch = await changes();
      audit('improve', { step: 'ready', id: st.id, checks: c.ok, changed: ch.changed });
      set({ status: 'ready', summary: r.text.slice(0, 6000), checks: c, ...ch, step: '' });
    })();
    return { ok: true };
  }

  // Apply: keep the current files, copy the staged ones over. Refused unless the staged copy passed its checks.
  function apply() {
    if (st.status !== 'ready') return { error: 'Nothing is ready to apply.' };
    if (!st.checks?.ok) return { error: 'The staged copy did not pass its checks, so it cannot be applied.' };
    if (!st.changed?.length) return { error: 'There are no changes to apply.' };
    const b = path.join(BACK, st.id);
    for (const f of st.changed) {
      const live = path.join(ROOT, f), keep = path.join(b, f); fs.mkdirSync(path.dirname(keep), { recursive: true });
      if (fs.existsSync(live)) fs.copyFileSync(live, keep); else fs.writeFileSync(keep + '.new', '');
      fs.mkdirSync(path.dirname(live), { recursive: true }); fs.copyFileSync(path.join(stage(), f), live);
    }
    audit('improve', { step: 'applied', id: st.id, changed: st.changed });
    set({ status: 'applied', applied: Date.now() });
    return { ok: true, restart: true };
  }
  function undo() {
    const id = lastBackup(); if (!id) return { error: 'Nothing to undo.' };
    const b = path.join(BACK, id), files = fs.readdirSync(b, { recursive: true }).map(String).filter(f => fs.statSync(path.join(b, f)).isFile());
    for (const f of files) f.endsWith('.new') ? fs.rmSync(path.join(ROOT, f.slice(0, -4)), { force: true }) : fs.copyFileSync(path.join(b, f), path.join(ROOT, f));
    fs.rmSync(b, { recursive: true, force: true });
    audit('improve', { step: 'undone', id, files });
    set({ status: 'idle', step: '' });
    return { ok: true, restart: true };
  }
  function discard() {
    if (child) { child.stopped = true; child.kill(); }
    audit('improve', { step: 'discarded', id: st.id });
    set({ status: 'idle', step: '', suggestions: undefined, diff: undefined, summary: undefined });
    return { ok: true };
  }
  return { view, start, implement, apply, undo, discard, busy: () => !!child };
};
