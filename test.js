// node test.js — checks the two things that must not break: the localhost guard and the tool server handshake.
const assert = require('assert'), { spawn } = require('child_process'), { okHost, label } = require('./server.js');

assert(okHost('127.0.0.1:4747') && okHost('localhost:4747'));
assert(!okHost('evil.com') && !okHost('127.0.0.1.evil.com:80') && !okHost('evil.com:4747') && !okHost(undefined));
assert.strictEqual(label('mcp__os__click', { x: 3, y: 4 }), 'click 3, 4');
assert.strictEqual(label('mcp__os__weather', { city: 'New Delhi' }), 'weather New Delhi');
assert.strictEqual(label('mcp__os__drag', { points: [{ x: 1, y: 2 }, { x: 9, y: 9 }, { x: 30, y: 40 }] }), 'drag 1, 2 to 30, 40');

// The drag tool: steps are filled in between the points, bad points are refused, and nothing moves before
// the mouse-and-keyboard gate has said yes.
const osTools = require('./ostools.js'), { dragPath } = osTools;
assert.deepStrictEqual(dragPath([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 5 }]), [[0, 0], [10, 0], [20, 0], [20, 5]]);
assert.strictEqual(dragPath([{ x: 0, y: 0 }, { x: 1000, y: 0 }]).length, 21);
for (const bad of [undefined, 'x', [], [{ x: 1, y: 1 }], [{ x: 1, y: 1 }, { x: 'a', y: 2 }], [{ x: 1, y: 1 }, { x: 2 }], Array(201).fill({ x: 1, y: 1 })])
  assert.throws(() => dragPath(bad), JSON.stringify(bad) + ' is not a drag');
let asked = [];
const gated = osTools({ hands: async (sid, what) => { asked.push(what); throw new Error('refused'); } });
assert.rejects(gated.drag.run({ points: [{ x: 5, y: 5 }, { x: 50, y: 60 }] }, 's'), /refused/)
  .then(() => assert.rejects(gated.drag.run({ points: [{ x: 5, y: 5 }] }, 's'), /points/))
  .then(() => assert.deepStrictEqual(asked, ['drag 5, 5 to 50, 60']));

// The read/write split that feeds the approval queue, model routing, and the pipeline CSV reader.
const { isRead, route, csv, forecast } = require('./desk.js');
// The weather tool's wording: live numbers rounded, and nothing invented when Open-Meteo leaves a field out.
const fc = forecast('New Delhi, Delhi, India', { current: { time: '2026-11-11T09:30', temperature_2m: 23.6, apparent_temperature: 24.2, relative_humidity_2m: 41, weather_code: 0, wind_speed_10m: 6.4 },
  daily: { time: ['2026-11-11', '2026-11-12', '2026-11-13'], weather_code: [0, 61, 3], temperature_2m_min: [18.7, 17.2, 17], temperature_2m_max: [28.1, 27.4, 26], precipitation_probability_max: [0, 55, 10] } }, { current: { us_aqi: 312, pm2_5: 180.4 } });
for (const want of ['Live weather for New Delhi, Delhi, India (Open-Meteo, as of 2026-11-11 09:30 local time)', 'Now: 24°C, feels like 24°C, clear, humidity 41%, wind 6 km/h', 'Air quality now: US AQI 312, PM2.5 180', 'Today: clear, 19 to 28°C, rain chance 0%', 'Tomorrow: light rain, 17 to 27°C, rain chance 55%', '2026-11-13: overcast, 17 to 26°C, rain chance 10%'])
  assert(fc.includes(want), 'forecast should say: ' + want);
assert.strictEqual(forecast('Pune', { daily: { time: ['2026-11-11'] } }, null), 'Live weather for Pune (Open-Meteo)\nToday: conditions unknown, ? to ?°C, rain chance ?%');
for (const p of ['gmail users messages list', 'gmail users messages get', 'calendar events list', 'schema gmail.users.messages.send', 'calendar freebusy query', 'gmail +triage', 'gmail users getProfile'])
  assert(isRead(p.split(' ')), p + ' should run at once');
for (const p of ['gmail users messages send', 'gmail users drafts create', 'gmail users messages trash', 'calendar events insert', 'calendar events delete', 'drive files update', 'gmail +send', 'gmail users messages batchDelete', 'list'])
  assert(!isRead(p.split(' ')), p + ' must wait for approval');
assert.strictEqual(route('what is on my calendar today?').engine, 'claude');
assert.strictEqual(route('Overnight: research 20 leads in property management').engine, 'fable');
assert.strictEqual(route('', { id: 'vault:x' }).engine, 'fable');
assert.deepStrictEqual(csv('a,b\n"x, y","say ""hi"""\n'), [{ a: 'x, y', b: 'say "hi"' }]);

const mcp = spawn(process.execPath, ['mcp.js'], { cwd: __dirname });
let out = '';
mcp.stdout.on('data', d => {
  out += d;
  const lines = out.trim().split('\n');
  if (lines.length < 2) return;
  const names = JSON.parse(lines[1]).result.tools.map(t => t.name);
  assert.deepStrictEqual(names, ['speak', 'screenshot', 'click', 'drag', 'type_text', 'press_key', 'open', 'gws', 'draft_email', 'save_lead', 'run_command', 'weather']);
  mcp.kill(); console.log('ok');
});
mcp.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
