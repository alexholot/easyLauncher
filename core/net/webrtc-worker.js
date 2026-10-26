'use strict';
// Скрытое окно Chromium: RTCPeerConnection и data channel для прямого пути.
// Главный процесс присылает команды через window.rtcBridge; данные — ArrayBuffer.
const bridge = window.rtcBridge;
const pcs = new Map(); // pcId → {pc, channels: Map<ch, dc>, pendingAcks: Map<ch, [id]>}
const LOW = 256 * 1024;
const emit = (msg) => bridge.send(msg);

function attach(rec, pcId, dc) {
  const ch = dc.label;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW;
  rec.channels.set(ch, dc);
  rec.acks.set(ch, []);
  dc.onopen = () => emit({ ev: 'open', pc: pcId, ch });
  dc.onmessage = (e) => emit({ ev: 'data', pc: pcId, ch, bytes: new Uint8Array(e.data) });
  dc.onclose = () => {
    rec.channels.delete(ch);
    emit({ ev: 'closed', pc: pcId, ch });
  };
  dc.onbufferedamountlow = () => {
    const list = rec.acks.get(ch) || [];
    rec.acks.set(ch, []);
    for (const id of list) emit({ ev: 'ack', pc: pcId, ch, id });
  };
}

async function routeOf(pc) {
  // Тип выбранной пары кандидатов: relay — значит через TURN, иначе прямой путь
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
  });
  if (!pair)
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
  const local = pair && stats.get(pair.localCandidateId);
  const remote = pair && stats.get(pair.remoteCandidateId);
  if (!local) return 'direct';
  return local.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'turn' : 'direct';
}

bridge.on(async (cmd) => {
  try {
    if (cmd.op === 'create') {
      const pc = new RTCPeerConnection({ iceServers: cmd.iceServers || [], iceTransportPolicy: cmd.policy || 'all' });
      const rec = { pc, channels: new Map(), acks: new Map() };
      pcs.set(cmd.pc, rec);
      pc.onicecandidate = (e) => emit({ ev: 'signal', pc: cmd.pc, data: { type: 'candidate', candidate: e.candidate ? e.candidate.toJSON() : null } });
      pc.onconnectionstatechange = async () => {
        const st = pc.connectionState;
        emit({ ev: 'state', pc: cmd.pc, state: st, route: st === 'connected' ? await routeOf(pc) : null });
      };
      pc.ondatachannel = (e) => {
        attach(rec, cmd.pc, e.channel);
        emit({ ev: 'channel', pc: cmd.pc, ch: e.channel.label });
      };
      if (cmd.role === 'guest') {
        attach(rec, cmd.pc, pc.createDataChannel('ctl'));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        emit({ ev: 'signal', pc: cmd.pc, data: { type: 'offer', sdp: offer.sdp } });
      }
    } else if (cmd.op === 'signal') {
      const rec = pcs.get(cmd.pc);
      if (!rec) return;
      const d = cmd.data;
      if (d.type === 'offer') {
        await rec.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        const answer = await rec.pc.createAnswer();
        await rec.pc.setLocalDescription(answer);
        emit({ ev: 'signal', pc: cmd.pc, data: { type: 'answer', sdp: answer.sdp } });
      } else if (d.type === 'answer') await rec.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      else if (d.type === 'candidate' && d.candidate) await rec.pc.addIceCandidate(d.candidate);
    } else if (cmd.op === 'open-channel') {
      const rec = pcs.get(cmd.pc);
      attach(rec, cmd.pc, rec.pc.createDataChannel(cmd.ch, { ordered: true }));
    } else if (cmd.op === 'data') {
      const dc = pcs.get(cmd.pc)?.channels.get(cmd.ch);
      if (!dc || dc.readyState !== 'open') return emit({ ev: 'ack', pc: cmd.pc, ch: cmd.ch, id: cmd.id, error: true });
      dc.send(cmd.bytes);
      // подтверждаем запись сразу, если буфер небольшой; иначе — когда он опустеет (обратное давление)
      if (dc.bufferedAmount <= LOW) emit({ ev: 'ack', pc: cmd.pc, ch: cmd.ch, id: cmd.id });
      else pcs.get(cmd.pc).acks.get(cmd.ch).push(cmd.id);
    } else if (cmd.op === 'close-channel') {
      pcs.get(cmd.pc)?.channels.get(cmd.ch)?.close();
    } else if (cmd.op === 'close') {
      const rec = pcs.get(cmd.pc);
      if (rec) {
        rec.pc.close();
        pcs.delete(cmd.pc);
      }
    }
  } catch (e) {
    emit({ ev: 'error', pc: cmd.pc, message: String(e && e.message) });
  }
});
emit({ ev: 'ready' });
