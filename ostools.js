// The tools both agents get: a voice, and hands on the Mac. They execute inside server.js (not inside the
// agent's own process), so they behave the same under Claude Code and under Codex's sandbox.
// Needs Accessibility + Screen Recording permission for the app that launched server.js.
const { execFile } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

const sh = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 5e7 }, (e, out, err) => e ? rej(new Error((err || e.message).trim())) : res(out.trim())));
const jxa = src => sh('osascript', ['-l', 'JavaScript', '-e', 'ObjC.import("CoreGraphics");' + src]);
const text = t => [{ type: 'text', text: t }];
const KEYCODES = { return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126, pagedown: 121, pageup: 116, home: 115, end: 119 };
const MODS = { cmd: 'command down', command: 'command down', shift: 'shift down', alt: 'option down', option: 'option down', ctrl: 'control down', control: 'control down' };

// A drag as the list of points the pointer passes through: the given points with steps filled in between,
// because apps ignore a drag that jumps. Throws on anything that is not 2 to 200 points with numeric x and y.
function dragPath(points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 200) throw new Error('points must be a list of 2 to 200 {x, y} points');
  const p = points.map(q => [Math.round(+(q?.x ?? q?.[0])), Math.round(+(q?.y ?? q?.[1]))]);
  if (!p.every(q => Number.isFinite(q[0]) && Number.isFinite(q[1]))) throw new Error('every point needs a numeric x and y taken from the latest screenshot');
  const out = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], n = Math.min(20, Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 10)));
    for (let k = 1; k <= n; k++) out.push([Math.round(ax + (bx - ax) * k / n), Math.round(ay + (by - ay) * k / n)]);
  }
  return out;
}

// hooks: { speak, vision, gws, draft, lead, shell, hands, weather } supplied by the server. Anything that sends, changes
// Google, runs a command or moves the mouse goes through a hook, where the approval rules are enforced.
module.exports = (hooks = {}) => ({
  speak: {
    description: 'Say something aloud to the user through their speakers. One to three short spoken sentences, no markdown.',
    props: { text: { type: 'string' } }, required: ['text'],
    run: async (a, sid) => { await hooks.speak(sid, String(a.text || '').slice(0, 1200)); return text('Spoken.'); },
  },
  screenshot: {
    description: 'Capture the main display. The image is scaled so its pixel coordinates are exactly the coordinates click expects.',
    props: {}, required: [],
    run: async (a, sid) => {
      const [w, h] = (await jxa('const d=$.CGMainDisplayID(); $.CGDisplayPixelsWide(d)+"x"+$.CGDisplayPixelsHigh(d)')).split('x').map(Number);
      const f = path.join(os.tmpdir(), `fable-os-${process.pid}-${Date.now()}.jpg`);
      await sh('screencapture', ['-x', '-t', 'jpg', f]);
      await sh('sips', ['--resampleWidth', String(w), '-s', 'formatOptions', '60', f]);
      const data = fs.readFileSync(f).toString('base64'); fs.unlinkSync(f);
      hooks.vision?.(sid, data);
      return [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: `Screen is ${w}x${h}. Image pixels equal click coordinates.` }];
    },
  },
  click: {
    description: 'Click at screen coordinates taken from the latest screenshot.',
    props: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right'] }, double: { type: 'boolean' } }, required: ['x', 'y'],
    run: async (a, sid) => {
      if (!Number.isFinite(+a.x) || !Number.isFinite(+a.y)) throw new Error('x and y must be numbers');
      await hooks.hands(sid, `click ${a.x}, ${a.y}`);
      const [down, up, btn] = a.button === 'right' ? [3, 4, 1] : [1, 2, 0];
      await jxa(`const p={x:${+a.x},y:${+a.y}};const ev=(t,n)=>{const e=$.CGEventCreateMouseEvent($(),t,p,${btn});if(n)$.CGEventSetIntegerValueField(e,1,n);$.CGEventPost(0,e)};
        ev(5);delay(0.08);ev(${down},1);ev(${up},1);${a.double ? `delay(0.06);ev(${down},2);ev(${up},2);` : ''}`);
      return text(`Clicked ${a.x}, ${a.y}.`);
    },
  },
  drag: {
    description: 'Press the left mouse button at the first point, move through the others in order, and release at the last. For drawing, moving or resizing things, and sliders. A straight line is two points; a curve is many points close together. Coordinates come from the latest screenshot. One call is one stroke.',
    props: { points: { type: 'array', description: 'Two to 200 points in order, e.g. [{"x":400,"y":300},{"x":600,"y":300}].', items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } } }, required: ['points'],
    run: async (a, sid) => {
      const p = dragPath(a.points), from = p[0], to = p[p.length - 1];
      await hooks.hands(sid, `drag ${from.join(', ')} to ${to.join(', ')}`);
      // The button is always released, even if a step fails, so the mouse is never left held down.
      await jxa(`const P=${JSON.stringify(p)};const ev=(t,q,n)=>{const e=$.CGEventCreateMouseEvent($(),t,{x:q[0],y:q[1]},0);if(n)$.CGEventSetIntegerValueField(e,1,n);$.CGEventPost(0,e)};
        ev(5,P[0]);delay(0.08);ev(1,P[0],1);try{delay(0.06);for(const q of P.slice(1)){ev(6,q);delay(0.004)}delay(0.06)}finally{ev(2,P[P.length-1],1)}`);
      return text(`Dragged from ${from.join(', ')} to ${to.join(', ')} through ${a.points.length} points.`);
    },
  },
  type_text: {
    description: 'Type text into whatever currently has keyboard focus.',
    props: { text: { type: 'string' } }, required: ['text'],
    run: async (a, sid) => { await hooks.hands(sid, `type "${String(a.text).slice(0, 60)}"`); await sh('osascript', ['-e', 'on run argv', '-e', 'tell application "System Events" to keystroke (item 1 of argv)', '-e', 'end run', String(a.text)]); return text('Typed.'); },
  },
  press_key: {
    description: 'Press a key or shortcut, e.g. "return", "cmd+space", "cmd+shift+t", "escape", "pagedown".',
    props: { keys: { type: 'string' } }, required: ['keys'],
    run: async (a, sid) => {
      await hooks.hands(sid, `press ${a.keys}`);
      const parts = String(a.keys).toLowerCase().split('+').map(s => s.trim()), key = parts.pop();
      const mods = parts.map(m => { if (!MODS[m]) throw new Error(`Unknown modifier "${m}"`); return MODS[m]; });
      const using = mods.length ? ` using {${mods.join(', ')}}` : '';
      if (!(key in KEYCODES) && !/^[a-z0-9`\-=\[\];',.\/\\]$/.test(key)) throw new Error(`Unknown key "${key}"`);
      await sh('osascript', ['-e', `tell application "System Events" to ${key in KEYCODES ? `key code ${KEYCODES[key]}` : `keystroke "${key === '\\' ? '\\\\' : key}"`}${using}`]);
      return text(`Pressed ${a.keys}.`);
    },
  },
  open: {
    description: 'Open an app by name ("Safari"), a URL, or a file path.',
    props: { target: { type: 'string' } }, required: ['target'],
    run: async (a, sid) => { const t = String(a.target); await hooks.hands(sid, `open ${t}`); await sh('open', /^(https?:|\/|~)/.test(t) ? [t.replace(/^~/, os.homedir())] : ['-a', t]); return text(`Opened ${t}.`); },
  },
  gws: {
    description: 'Google Workspace (Gmail, Calendar, Drive, Docs, Sheets, Tasks, People). Reads (list, get, search, schema) run at once and return JSON. Anything that sends or changes is not run: it is placed in the user\'s approval queue and runs only when they click. For email use draft_email instead.',
    props: { path: { type: 'string', description: 'Service, resources and method, e.g. "gmail users messages list", "calendar events list", or "schema gmail.users.messages.get" to look up parameters.' }, params: { type: 'object', description: 'URL and query parameters, e.g. {"userId":"me","q":"is:unread","maxResults":5}' }, body: { type: 'object', description: 'Request body for writes.' } }, required: ['path'],
    run: async (a, sid) => text(await hooks.gws(sid, a)),
  },
  draft_email: {
    description: 'Put an email in the user\'s approval queue. It is never sent by you: it goes only when the user clicks Send, and they can edit it first. Use kind "proposal" for a proposal or pitch to a lead or client.',
    props: { to: { type: 'string', description: 'Recipient address(es), comma-separated. Optional when replying.' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain text.' }, cc: { type: 'string' }, reply_to_message_id: { type: 'string', description: 'Gmail message id to reply to, keeps the thread.' }, kind: { type: 'string', enum: ['email', 'proposal'] }, lead: { type: 'string', description: 'For a proposal: the lead name plus company, exactly as given to save_lead.' } }, required: ['body'],
    run: async (a, sid) => text(await hooks.draft(sid, a)),
  },
  save_lead: {
    description: 'Add or update a lead on the user\'s business board. Call it once per qualified lead you find, and again to change its status.',
    props: { name: { type: 'string', description: 'Person, or the company if no person is known.' }, company: { type: 'string' }, segment: { type: 'string' }, fit: { type: 'string', description: 'One or two sentences: why this is a good lead, with the evidence.' }, source: { type: 'string', description: 'URL or vault note where you found them.' }, contact: { type: 'string', description: 'Public email, profile or site.' }, status: { type: 'string', enum: ['new', 'contacted', 'proposal', 'won', 'lost'] }, value_usd: { type: 'number', description: 'Monthly value if known.' }, notes: { type: 'string' } }, required: ['name'],
    run: async (a, sid) => text(await hooks.lead(sid, a)),
  },
  run_command: {
    description: 'Ask the user to approve one shell command, run in the vault. The call waits until they click; if they are away it comes back refused after ten minutes. Only for commands a skill genuinely needs, such as its own scripts.',
    props: { command: { type: 'string' }, why: { type: 'string', description: 'One sentence the user reads before approving.' } }, required: ['command'],
    run: async (a, sid) => text(await hooks.shell(sid, a)),
  },
  weather: {
    description: 'Live weather now and for the next three days, with air quality, from Open-Meteo. Use it for any weather question instead of web search. Leave city out to use the user\'s saved home city.',
    props: { city: { type: 'string', description: 'City name, e.g. "New Delhi". Omit to use the saved home city.' }, home: { type: 'boolean', description: 'Set true only when the user has said this city is where he lives. It is saved so he is not asked again.' } }, required: [],
    run: async (a, sid) => text(await hooks.weather(sid, a)),
  },
});
module.exports.dragPath = dragPath;
