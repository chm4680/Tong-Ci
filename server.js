const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

const rooms = new Map();        // code -> room

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
    roundStartAt: 0,
    submissions: {},     // playerId -> word
    initialWords: null,
    lastWords: null,
    lastScores: null,
    endReason: null,     // win | nobody | null
    history: [],
    timer: null,
  };
}

function roomState(room) {
  const players = [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    score: p.score,
    matched: p.matched,
    inRound: p.inRound,
    submitted: p.id in room.submissions,
    confirmed: p.confirmed,
    confirmedSubmit: p.confirmedSubmit,
    votedEnd: p.votedEnd,
    passed: room.phase === 'round' && room.submissions[p.id] === '',
  }));
  return {
    code: room.code,
    hostId: room.host,
    phase: room.phase,
    round: room.round,
    deadline: room.deadline,
    tFirst: room.tFirst,
    tNext: room.tNext,
    players,
    submittedCount: players.filter((p) => p.submitted && p.alive).length,
    confirmedCount: players.filter((p) => p.confirmed && p.alive).length,
    confirmedSubmitCount: players.filter((p) => p.confirmedSubmit && p.alive).length,
    votedCount: players.filter((p) => p.votedEnd && p.alive).length,
    initialWords: room.initialWords,
    lastWords: room.lastWords,
    ended: room.phase === 'ended',
    endReason: room.endReason,
    history: room.history,
    lastScores: room.lastScores,
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
  const secs = room.round === 1 ? room.tFirst : room.tNext;
  room.roundStartAt = Date.now();
  room.deadline = room.roundStartAt + secs * 1000;
  for (const p of room.players.values()) {
    p.confirmed = false;
    p.confirmedSubmit = false;
    p.confirmedAt = null;
    p.votedEnd = false;
    p.wasInRound = false;
  }
  for (const p of alivePlayers(room)) p.inRound = true;
  room.timer = setTimeout(() => endRound(room), secs * 1000);
  pushState(room);
}

// 速度积分：前 20 秒满分 20，之后线性下降到倒计时结束的 10 分
function speedScore(t, T) {
  const secs = Math.max(0, Math.min(t, T));
  if (secs <= 20 || T <= 20) return 20;
  return Math.max(10, Math.round(20 - (10 * (secs - 20)) / (T - 20)));
}

function endRound(room) {
  clearTimer(room);
  room.phase = 'reveal';
  const roundPlayers = alivePlayers(room).filter((p) => p.inRound);
  const T = Math.max(1, (room.deadline - room.roundStartAt) / 1000);
  // 倒计时结束：还没确认提交的玩家视为压线自动提交
  for (const p of roundPlayers) {
    if (!p.confirmedSubmit) p.confirmedAt = room.deadline;
  }
  const words = roundPlayers.map((p) => ({ name: p.name, word: room.submissions[p.id] || null, passed: room.submissions[p.id] === '' }));
  room.lastWords = words;
  room.history.push({ round: room.round, words });
  // 弃权者没有词，不参与相遇判定，也不影响其他人相遇
  const contenders = roundPlayers.filter((p) => room.submissions[p.id]);
  const submitted = contenders.map((p) => room.submissions[p.id]);

  const counts = new Map();
  for (const w of submitted) counts.set(norm(w), (counts.get(norm(w)) || 0) + 1);
  const speedOf = (p) => speedScore((p.confirmedAt - room.roundStartAt) / 1000, T);

  // 同步奖励：与至少一名其他人词相同的玩家，按提交速度得分（最快 20，压线保底 10）
  for (const p of roundPlayers) {
    const w = room.submissions[p.id];
    if (w && counts.get(norm(w)) >= 2) {
      p.score += speedOf(p);
      p.matched += 1;
    }
  }

  const converged =
    contenders.length >= 2 &&
    submitted.length === contenders.length &&
    submitted.every((w) => norm(w) === norm(submitted[0]));

  if (converged) {
    room.phase = 'ended';
    room.endReason = 'win';
    room.lastScores = roundPlayers.map((p) => ({
      name: p.name,
      speed: room.submissions[p.id] === '' ? 0 : speedOf(p),
      total: p.score,
      word: submitted[0],
    }));
  } else if (submitted.length === 0) {
    // 无人提交：游戏自动结束
    room.phase = 'ended';
    room.endReason = 'nobody';
    room.lastScores = null;
  } else {
    // 公示阶段：等所有存活玩家确认后再进入下一轮
    for (const q of alivePlayers(room)) {
      q.confirmed = false;
      q.votedEnd = false;
    }
  }
  pushState(room);
}

function endByVote(room) {
  room.phase = 'ended';
  room.endReason = 'vote';
  for (const p of alivePlayers(room)) p.score += 20;
  room.lastScores = alivePlayers(room).map((p) => ({
    name: p.name, vote: 20, total: p.score, word: null,
  }));
  pushState(room);
}

function checkAllVoted(room) {
  if (room.phase !== 'reveal') return;
  const alive = alivePlayers(room);
  if (alive.length > 0 && alive.every((q) => q.votedEnd)) endByVote(room);
}

function checkAllConfirm(room) {
  if (room.phase !== 'reveal') return;
  const alive = alivePlayers(room);
  if (alive.length > 0 && alive.every((q) => q.confirmed)) {
    room.round += 1;
    startRound(room);
  }
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
  for (const p of room.players.values()) {
    p.score = 0;
    p.matched = 0;
    p.confirmed = false;
    p.inRound = false;
    p.confirmedSubmit = false;
    p.confirmedAt = null;
    p.votedEnd = false;
    p.wasInRound = false;
  }
  room.phase = 'initial';
  room.round = 0;
  room.deadline = 0;
  room.roundStartAt = 0;
  room.submissions = {};
  room.initialWords = null;
  room.lastWords = null;
  room.lastScores = null;
  room.endReason = null;
  room.history = [];
  pushState(room);
}

// 房主随时重新开始：所有人回到大厅，积分清零
function restart(room) {
  clearTimer(room);
  for (const [id, p] of [...room.players]) if (!p.alive) room.players.delete(id);
  for (const p of room.players.values()) {
    p.score = 0;
    p.matched = 0;
    p.confirmed = false;
    p.inRound = false;
    p.confirmedSubmit = false;
    p.confirmedAt = null;
    p.votedEnd = false;
    p.wasInRound = false;
  }
  room.phase = 'lobby';
  room.round = 0;
  room.deadline = 0;
  room.roundStartAt = 0;
  room.submissions = {};
  room.initialWords = null;
  room.lastWords = null;
  room.lastScores = null;
  room.endReason = null;
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
        p.wasInRound = p.inRound;
        p.inRound = false;
        if (room.phase === 'initial') {
          checkAllInitialSubmitted(room);
        } else if (room.phase === 'reveal') {
          checkAllConfirm(room);
          checkAllVoted(room);
        }
        pushState(room);
        return;
      }
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
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
      const player = { id: genId(), name, ws, alive: true, score: 0, matched: 0, inRound: false, confirmed: false, confirmedSubmit: false, confirmedAt: null, votedEnd: false, wasInRound: false, room };
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
        // 本轮中断线重连：恢复本轮参与资格，可继续游玩
        if (room.phase === 'round' && existing.wasInRound) existing.inRound = true;
        existing.wasInRound = false;
        send(ws, { type: 'joined', code: room.code, playerId: existing.id });
        if (room.phase === 'round' && existing.id in room.submissions) {
          send(ws, { type: 'myWord', word: room.submissions[existing.id] });
        }
        pushState(room);
        return;
      }
      const player = { id: genId(), name, ws, alive: true, score: 0, matched: 0, inRound: false, confirmed: false, confirmedSubmit: false, confirmedAt: null, votedEnd: false, wasInRound: false, room };
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
      room.tFirst = Math.min(180, Math.max(20, Number(msg.tFirst) || 60));
      room.tNext = Math.min(180, Math.max(20, Number(msg.tNext) || 60));
      room.phase = 'initial';
      room.round = 0;
      room.submissions = {};
      room.initialWords = null;
      room.lastWords = null;
      room.lastScores = null;
      room.endReason = null;
      room.history = [];
      for (const q of room.players.values()) {
        q.score = 0;
        q.matched = 0;
        q.confirmed = false;
      }
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
      if (room.phase !== 'initial' && room.phase !== 'round') return;
      if (room.phase === 'round') {
        if (!p.inRound) return send(ws, { type: 'error', message: '本轮你未参与，下一轮再提交' });
        if (p.id in room.submissions) return send(ws, { type: 'error', message: '本轮已提交' });
      }
      const word = String(msg.word || '').trim().slice(0, 50);
      if (!word && room.phase !== 'round') return;
      if (room.phase === 'initial' && p.id in room.submissions) return; // 初始词提交后不可改
      room.submissions[p.id] = word;
      if (room.phase === 'round' && !word) p.score -= 10; // 主动弃权扣分
      if (room.phase === 'initial') {
        pushState(room);
        checkAllInitialSubmitted(room);
        return;
      }
      send(ws, { type: 'myWord', word });
      pushState(room);
      return;
    }

    if (msg.type === 'confirmSubmit') {
      if (room.phase !== 'round' || !p.inRound || p.confirmedSubmit) return;
      if (!(p.id in room.submissions)) return;
      p.confirmedSubmit = true;
      p.confirmedAt = Date.now();
      const inRound = alivePlayers(room).filter((q) => q.inRound);
      if (inRound.every((q) => q.confirmedSubmit)) endRound(room);
      else pushState(room);
      return;
    }

    if (msg.type === 'unsubmit') {
      if (room.phase !== 'round' || !(p.id in room.submissions) || p.confirmedSubmit) return;
      if (room.submissions[p.id] === '') p.score += 10; // 撤回弃权，返还扣分
      delete room.submissions[p.id];
      pushState(room);
      return;
    }

    if (msg.type === 'confirm') {
      if (room.phase !== 'reveal' || p.confirmed) return;
      p.confirmed = true;
      pushState(room);
      checkAllConfirm(room);
      return;
    }

    if (msg.type === 'voteEnd') {
      if (room.phase !== 'reveal' || p.votedEnd) return;
      p.votedEnd = true;
      pushState(room);
      checkAllVoted(room);
      return;
    }

    if (msg.type === 'restart') {
      if (p.id !== room.host) return;
      restart(room);
      return;
    }

    if (msg.type === 'rematch') {
      if (room.phase === 'ended') rematch(room);
      return;
    }
  });

  ws.on('close', () => detach(ws));
});

// 心跳：清掉已经死掉的连接，防止它们占着服务器资源
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

server.listen(PORT, () => console.log(`同词相遇已启动: http://localhost:${PORT}`));
