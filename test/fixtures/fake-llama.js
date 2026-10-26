#!/usr/bin/env node
'use strict';
// Имитация llama-server для тестов: /health и /v1/chat/completions. Не нейросеть.
const http = require('http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const mode = process.env.FAKE_LLAMA_MODE || 'good';
const ballast = Buffer.alloc(200 * 1024 * 1024, 1); // имитация весов модели в памяти
let ready = false;
setTimeout(() => (ready = true), 300);
http
  .createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(ready ? 200 : 503);
      return res.end(JSON.stringify({ status: ready ? 'ok' : 'loading' }));
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body);
      const user = j.messages[1].content;
      const props = j.response_format.json_schema.schema.properties;
      let out;
      if (props.intent) {
        if (mode === 'garbage') out = 'не json {';
        else if (mode === 'inject') out = JSON.stringify({ intent: 'build', themes: ['technology'], avoid: [], searchTerms: [], players: 4, lowEnd: false, clarify: null, run: 'rm -rf /' });
        else if (mode === 'hallucinate') out = JSON.stringify({ intent: 'add', themes: [], avoid: [], searchTerms: ['SuperMegaMod9000'], players: null, lowEnd: false, clarify: null });
        else if (mode === 'badurl') out = JSON.stringify({ intent: 'add', themes: [], avoid: [], searchTerms: ['https://evil.example/mod.jar'], players: null, lowEnd: false, clarify: null });
        else out = JSON.stringify({ intent: 'build', themes: /create|техн/i.test(user) ? ['technology'] : ['adventure'], avoid: [], searchTerms: /create/i.test(user) ? ['Create'] : [], players: /четыр/i.test(user) ? 4 : null, lowEnd: false, clarify: null });
      } else if (props.text) {
        out = JSON.stringify({ text: mode === 'badurl' ? 'Скачай с https://evil.example' : mode === 'othermod' ? 'Добавлю Create и ещё Sodium.' : 'Добавлю Create и нужный ему Fabric API.' });
      } else out = JSON.stringify({ summary: 'Недостаточно данных: нужен полный crash-report.', confident: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: out } }], ballast: ballast.length }));
    });
  })
  .listen(port, '127.0.0.1');
