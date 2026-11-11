// node voicecheck.js — with the server running: speaks a line through ElevenLabs, then transcribes it back.
const B = 'http://127.0.0.1:' + (process.env.PORT || 4747);
(async () => {
  const sse = await fetch(B + '/api/stream'), reader = sse.body.getReader(), dec = new TextDecoder();
  fetch(B + '/api/os', { method: 'POST', body: JSON.stringify({ sessionId: 'check', tool: 'speak', args: { text: 'Fable OS voice check, one two three.' } }) });
  let buf = '';
  for (;;) {
    const { value } = await reader.read(); buf += dec.decode(value);
    const m = buf.match(/"type":"speak".*?"url":("[^"]*"|null)/);
    if (!m) continue;
    if (m[1] === 'null') throw new Error('Text to speech failed; see the Pulse feed.');
    const mp3 = await (await fetch(B + JSON.parse(m[1]))).arrayBuffer();
    const r = await (await fetch(B + '/api/stt', { method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: mp3 })).json();
    console.log(`spoke ${mp3.byteLength} bytes, heard back:`, r.text || r.error);
    process.exit(r.text ? 0 : 1);
  }
})();
