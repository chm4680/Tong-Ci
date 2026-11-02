const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const REVEAL_MS = Number(process.env.REVEAL_MS) || 8000; // 展示结果后自动进入下一轮的等待时间

const rooms = new Map();        // code -> room
const leaderboard = new Map();  // name -> 累计积分（存在服务器内存中，重启清零）

const norm = (w) => String(w || '').trim().toLowerCase();
const genId = () => Math.random().toString(36).slice(2, 10);
const genCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
};

function createRoom() {
  return {
    code: genCode(),
    host: null,
    players: new Map(),  // id -> player
    phase: 'lobby',      // lobby | initial | round | reveal | ended
    round: 0,
    tFirst: 60,
    tNext: 60,
    deadline: 0,
    nextRoundAt: 0,
    submissions: {},     // playerId -> word
    initialWords: null,
    lastWords: null,
    lastScoreDelta: null,
    history: [],
    timer: null,
  };
}

function addScore(name, delta) {
  leaderboard.set(name, (leaderboard.get(name) || 0) + delta);
}

function roomState(room) {
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    score: p.score,
    inRound: p.inRound,
    submitted: p.id in room.submissions,
  }));
  return {
    code: room.code,
    hostId: room.host,
    phase: room.phase,
    round: room.round,
    deadline: room.deadline,
    nextRoundAt: room.nextRoundAt,
    tFirst: room.tFirst,
    tNext: room.tNext,
    players,
    submittedCount: players.filter((p) => p.submitted && p.alive).length,
    initialWords: room.initialWords,
    lastWords: room.lastWords,
    ended: room.phase === 'ended',
    history: room.history,
    scoreDelta: room.lastScoreDelta,
    leaderboard: [...leaderboard.entries()]
      .map(([name, score]) => ({ name, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20),
  };
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  for (const p of room.players.values()) send(p.ws, obj);
}
function pushState(room) {
  broadcast(room, { type: 'state', state: roomState(room) });
}

const alivePlayers = (room) => [...room.players.values()].filter((p) => p.alive);

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function startRound(room) {
  clearTimer(room);
  room.phase = 'round';
  room.submissions = {};
  room.nextRoundAt = 0;
  const secs = room.round === 1 ? room.tFirst : room.tNext;
  room.deadline = Date.now() + secs * 1000;
  for (const p of alivePlayers(room)) p.inRound = true;
  room.timer = setTimeout(() => endRound(room), secs * 1000);
  pushState(room);
}

function endRound(room) {
  clearTimer(room);
  room.phase = 'reveal';
  const roundPlayers = alivePlayers(room).filter((p) => p.inRound);
  const words = roundPlayers.map((p) => ({ name: p.name, word: room.submissions[p.id] || null }));
  room.lastWords = words;
  room.history.push({ round: room.round, words });
  const submitted = words.filter((w) => w.word);
  const converged =
    words.length >= 2 &&
    submitted.length === words.length &&
    submitted.every((w) => norm(w.word) === norm(submitted[0].word));

  if (converged) {
    room.phase = 'ended';
    const r = room.round;
    const perRound = 10 * r;
    const win = 50;
    const speed = Math.max(0, 10 - r) * 10;
    room.lastScoreDelta = { perRound, win, speed, total: perRound + win + speed, word: submitted[0].word };
    for (const p of roundPlayers) {
      p.score += room.lastScoreDelta.total;
      addScore(p.name, room.lastScoreDelta.total);
    }
  } else {
    room.nextRoundAt = Date.now() + REVEAL_MS;
    room.timer = setTimeout(() => {
      room.round += 1;
      startRound(room);
    }, REVEAL_MS);
  }
  pushState(room);
}

function checkAllInitialSubmitted(room) {
  if (room.phase !== 'initial') return;
  if (alivePlayers(room).every((p) => p.id in room.submissions)) {
    room.initialWords = alivePlayers(room).map((p) => ({ name: p.name, word: room.submissions[p.id] }));
    room.round = 1;
    startRound(room);
  }
}

function rematch(room) {
  clearTimer(room);
  for (const [id, p] of [...room.players]) if (!p.alive) room.players.delete(id);
  room.phase = 'initial';
  room.round = 0;
  room.deadline = 0;
  room.nextRoundAt = 0;
  room.submissions = {};
  room.initialWords = null;
  room.lastWords = null;
  room.lastScoreDelta = null;
  room.history = [];
  pushState(room);
}

function findPlayer(ws) {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) if (p.ws === ws) return p;
  }
  return null;
}

// 把该连接从它原来所在的房间中移除（换房间、断线时用）
function detach(ws) {
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.ws === ws && p.alive) {
        p.alive = false;
        p.inRound = false;
        if (room.phase === 'initial') checkAllInitialSubmitted(room);
        pushState(room);
        return;
      }
    }
  }
}

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || !msg.type) return;

    if (msg.type === 'create') {
      const name = String(msg.name || '').trim().slice(0, 12);
      if (!name) return send(ws, { type: 'error', message: '昵称不能为空' });
      detach(ws);
      const room = createRoom();
      rooms.set(room.code, room);
      const player = { id: genId(), name, ws, alive: true, score: 0, inRound: false, room };
      room.players.set(player.id, player);
      room.host = player.id;
      send(ws, { type: 'joined', code: room.code, playerId: player.id });
      pushState(room);
      return;
    }

    if (msg.type === 'join') {
      const code = norm(msg.code).toUpperCase();
      const name = String(msg.name || '').trim().slice(0, 12);
      if (!name) return send(ws, { type: 'error', message: '昵称不能为空' });
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', message: '房间不存在，请检查房间码' });
      detach(ws);
      const existing = [...room.players.values()].find((p) => p.name === name);
      if (existing) {
        // 同昵称视为重连，恢复积分；若原连接还开着，把它顶掉
        if (existing.ws && existing.ws !== ws) {
          send(existing.ws, { type: 'kicked' });
          try { existing.ws.close(); } catch {}
        }
        existing.ws = ws;
        existing.alive = true;
        send(ws, { type: 'joined', code: room.code, playerId: existing.id });
        pushState(room);
        return;
      }
      const player = { id: genId(), name, ws, alive: true, score: 0, inRound: false, room };
      room.players.set(player.id, player);
      send(ws, { type: 'joined', code: room.code, playerId: player.id });
      pushState(room);
      return;
    }

    const p = findPlayer(ws);
    if (!p) return;
    const room = p.room;

    if (msg.type === 'start') {
      if (room.phase !== 'lobby' || p.id !== room.host) return;
      room.tFirst = Math.min(600, Math.max(5, Number(msg.tFirst) || 60));
      room.tNext = Math.min(600, Math.max(5, Number(msg.tNext) || 60));
      room.phase = 'initial';
      room.round = 0;
      room.submissions = {};
      room.initialWords = null;
      room.lastWords = null;
      room.lastScoreDelta = null;
      room.history = [];
      pushState(room);
      return;
    }

    if (msg.type === 'forceStart') {
      if (room.phase !== 'initial' || p.id !== room.host) return;
      room.initialWords = alivePlayers(room).map((x) => ({ name: x.name, word: room.submissions[x.id] || null }));
      room.round = 1;
      startRound(room);
      return;
    }

    if (msg.type === 'submit') {
      if (room.phase === 'round' && !p.inRound) {
        return send(ws, { type: 'error', message: '本轮你未参与，下一轮再提交' });
      }
      if (room.phase !== 'initial' && room.phase !== 'round') return;
      const word = String(msg.word || '').trim().slice(0, 50);
      if (!word) return;
      if (room.phase === 'initial' && p.id in room.submissions) return; // 初始词提交后不可改
      room.submissions[p.id] = word;
      pushState(room);
      if (room.phase === 'initial') checkAllInitialSubmitted(room);
      return;
    }

    if (msg.type === 'rematch') {
      if (room.phase === 'ended') rematch(room);
      return;
    }
  });

  ws.on('close', () => detach(ws));
});

server.listen(PORT, () => console.log(`同词相遇已启动: http://localhost:${PORT}`));
