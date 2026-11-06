import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import * as G from './game';
import { CATEGORIES } from '../data/words';
import type { Room } from '../lib/types';

const PORT = Number(process.env.PORT ?? 3000);
const HTML = path.resolve(process.cwd(), 'public/index.html');
const rooms = new Map<string, Room>();
const sessions = new Map<string, { code: string; id: string }>();
const sockets = new Map<string, Socket>();
const emptySince = new Map<string, number>();
const str = (v: unknown, n = 40) => String(v ?? '').slice(0, n);

const iceServers: object[] = [{ urls: 'stun:stun.l.google.com:19302' }];
if (process.env.TURN_URL) iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
const config = { iceServers, categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, c]) => [k, c.label])) };

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/config')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return void res.end(JSON.stringify(config));
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(HTML));
});
const io = new Server(server, { maxHttpBufferSize: 1e5 });

function broadcast(room: Room) {
  for (const p of room.players) sockets.get(p.id)?.emit('state', { ...G.viewFor(room, p.id), now: Date.now() });
}

io.on('connection', (s) => {
  let me: { code: string; id: string } | null = null;
  let hits = 0, sigHits = 0;
  const reset = setInterval(() => { hits = 0; sigHits = 0; }, 1000);
  const attach = (room: Room, id: string) => { me = { code: room.code, id }; sockets.set(id, s); s.join(room.code); emptySince.delete(room.code); };
  const sys = (room: Room, text: string) => io.to(room.code).emit('chat', { sys: 1, text, t: Date.now() });

  const on = (ev: string, fn: (p: any, room: Room) => object | void, needRoom = true) =>
    s.on(ev, (p: any, ack?: (r: object) => void) => {
      if (ev === 'signal' ? ++sigHits > 600 : ++hits > 40) return; // spam
      try {
        const room = me ? rooms.get(me.code) : undefined;
        if (needRoom && !room) throw new G.GameError('NO_ROOM');
        ack?.({ ok: true, ...(fn(p ?? {}, room as Room) ?? {}) });
      } catch (e) {
        const code = e instanceof G.GameError ? e.code : (e as Error).message === 'EMPTY_POOL' ? 'EMPTY_POOL' : 'ERROR';
        if (code === 'ERROR') console.error(e);
        ack?.({ ok: false, error: code });
      }
    });

  on('create', (p) => {
    const id = randomUUID(), token = randomUUID();
    const room = G.createRoom(id, str(p.nick, 60), typeof p.settings === 'object' ? p.settings : {}, new Set(rooms.keys()));
    rooms.set(room.code, room); sessions.set(token, { code: room.code, id }); attach(room, id);
    queueMicrotask(() => broadcast(room));
    return { token, id, code: room.code };
  }, false);

  on('join', (p) => {
    const room = rooms.get(str(p.code, 6).toUpperCase().trim());
    if (!room) throw new G.GameError('NO_ROOM');
    const id = randomUUID(), token = randomUUID();
    const pl = G.joinRoom(room, id, str(p.nick, 60));
    sessions.set(token, { code: room.code, id }); attach(room, id);
    queueMicrotask(() => { sys(room, `${pl.nick} dołączył(a)`); broadcast(room); });
    return { token, id, code: room.code };
  }, false);

  on('resume', (p) => {
    const ses = sessions.get(str(p.token, 60));
    const room = ses && rooms.get(ses.code);
    if (!ses || !room || !room.players.some((x) => x.id === ses.id)) throw new G.GameError('NO_ROOM');
    sockets.get(ses.id)?.disconnect(true); // jedno połączenie na gracza
    G.setConnected(room, ses.id, true); attach(room, ses.id);
    queueMicrotask(() => broadcast(room));
    return { id: ses.id, code: room.code };
  }, false);

  on('settings', (p, room) => {
    G.updateSettings(room, me!.id, {
      categories: Array.isArray(p.categories) ? p.categories.map((c: unknown) => str(c, 20)) : undefined,
      rounds: Number(p.rounds), turnSeconds: Number(p.turnSeconds), maxTurns: Number(p.maxTurns),
    });
    broadcast(room);
  });
  on('kick', (p, room) => {
    const t = sockets.get(str(p.id, 60));
    G.kick(room, me!.id, str(p.id, 60));
    t?.emit('kicked'); t?.leave(room.code); sockets.delete(str(p.id, 60)); broadcast(room);
  });
  on('start', (_p, room) => { G.startGame(room, me!.id, Date.now()); broadcast(room); });
  on('guess', (p, room) => {
    const text = str(p.text, 60).trim();
    const nick = room.players.find((x) => x.id === me!.id)?.nick ?? '';
    const r = G.guess(room, me!.id, Number(p.turnId), text, Date.now());
    sys(room, r.correct ? `${nick} zgadł(a) hasło „${r.word}” i zdobywa ${r.gained} pkt!` : `${nick} zgaduje „${text}” i pudłuje`);
    broadcast(room);
    return { correct: r.correct };
  });
  on('pass', (p, room) => { G.endTurn(room, me!.id, Number(p.turnId), Date.now()); broadcast(room); });
  on('next', (_p, room) => { G.nextRound(room, me!.id, Date.now()); broadcast(room); });
  on('again', (_p, room) => { G.resetToLobby(room, me!.id); broadcast(room); });
  on('chat', (p, room) => {
    const text = str(p.text, 200).trim();
    const pl = room.players.find((x) => x.id === me!.id);
    if (text && pl) io.to(room.code).emit('chat', { from: pl.nick, text, t: Date.now() });
  });
  on('signal', (p, room) => {
    if (room.players.some((x) => x.id === p.to)) sockets.get(p.to)?.emit('signal', { from: me!.id, data: p.data });
  });
  on('leave', (_p, room) => {
    const nick = room.players.find((x) => x.id === me!.id)?.nick;
    const empty = G.removePlayer(room, me!.id);
    s.leave(room.code); sockets.delete(me!.id); me = null;
    if (empty) rooms.delete(room.code); else { sys(room, `${nick} opuścił(a) pokój`); broadcast(room); }
  });

  s.on('disconnect', () => {
    clearInterval(reset);
    if (!me) return;
    const { code, id } = me;
    const room = rooms.get(code);
    if (sockets.get(id) === s) sockets.delete(id);
    if (!room || sockets.get(id)) return;
    G.setConnected(room, id, false);
    if (room.hostId === id) { const o = room.players.find((x) => x.connected); if (o) room.hostId = o.id; }
    broadcast(room);
    setTimeout(() => { // w lobby usuwamy po 20 s nieobecności; w trakcie gry punkty zostają
      const p = room.players.find((x) => x.id === id);
      if (p && !p.connected && room.phase === 'lobby' && rooms.has(code)) { G.removePlayer(room, id); broadcast(room); }
    }, 20_000);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (G.tick(room, now)) broadcast(room);
    if (room.phase === 'reveal' && room.revealDeadline !== null && now >= room.revealDeadline) { G.nextRound(room, room.hostId, now); broadcast(room); }
    if (room.players.some((p) => p.connected)) emptySince.delete(code);
    else if (now - (emptySince.get(code) ?? (emptySince.set(code, now), now)) > 60_000) rooms.delete(code);
  }
}, 250);

server.listen(PORT, () => console.log(`Czółko z Ekipą: http://localhost:${PORT}`));