import { randomInt } from 'node:crypto';
import { buildPool, foldWord, normalizeWord } from '../data/words';
import type { BoardEntry, Player, Room, RoomView, Settings } from '../lib/types';

export class GameError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

type Rng = () => number;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TURN_SECONDS = [0, 15, 20, 30, 45, 60]; // 0 = bez limitu czasu (tura trwa do kliknięcia „Zadałem pytanie” lub pudła)
export const REVEAL_MS = 8000; // jak długo widać hasła po zakończeniu rundy
const clamp = (n: number, a: number, b: number) => (Number.isFinite(n) ? Math.min(b, Math.max(a, Math.trunc(n))) : a);

export const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 6, rounds: 3, turnSeconds: 30, maxTurns: 8, categories: ['all'], customWords: [],
};

export function normalizeNick(raw: string): string {
  const nick = raw.replace(/\s+/g, ' ').trim();
  if (nick.length < 1 || nick.length > 20) throw new GameError('INVALID_NICK');
  return nick;
}

export function normalizeSettings(input: Partial<Settings>): Settings {
  const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const s = { ...DEFAULT_SETTINGS, ...given } as Settings;
  const customWords = [...new Set((s.customWords ?? []).map(normalizeWord).filter(Boolean))].slice(0, 500);
  const categories = Array.isArray(s.categories) && s.categories.length ? s.categories : ['all'];
  const turnSeconds = TURN_SECONDS.includes(s.turnSeconds) ? s.turnSeconds : DEFAULT_SETTINGS.turnSeconds;
  const settings: Settings = {
    maxPlayers: clamp(s.maxPlayers, 2, 6), rounds: clamp(s.rounds, 1, 30), turnSeconds,
    maxTurns: clamp(s.maxTurns, 1, 30), categories, customWords,
  };
  buildPool(settings.categories, settings.customWords); // rzuca EMPTY_POOL
  return settings;
}

export function generateCode(taken: ReadonlySet<string>): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
}

const newPlayer = (id: string, nick: string): Player =>
  ({ id, nick: normalizeNick(nick), connected: true, ready: false, score: 0, correct: 0, roundGained: 0 });

export function createRoom(hostId: string, nick: string, input: Partial<Settings>, taken: ReadonlySet<string>): Room {
  const settings = normalizeSettings(input);
  return {
    code: generateCode(taken), hostId, players: [newPlayer(hostId, nick)], settings, phase: 'lobby',
    round: 0, order: [], cursor: 0, activeId: null, turnId: 0, secrets: {}, pool: [], used: new Set(),
    deadline: null, revealDeadline: null, lastResult: null,
  };
}

export function joinRoom(room: Room, id: string, nick: string): Player {
  if (room.players.some((p) => p.id === id)) throw new GameError('ALREADY_JOINED');
  if (room.phase !== 'lobby') throw new GameError('GAME_STARTED');
  if (room.players.length >= room.settings.maxPlayers) throw new GameError('ROOM_FULL');
  const p = newPlayer(id, nick);
  room.players.push(p);
  return p;
}

/**
 * Powrót do rozpoczętej gry: gracz, który wypadł (odświeżenie, zamknięta karta, utrata sieci),
 * odzyskuje swoje miejsce i punkty po nicku. Dotyczy tylko rozłączonych graczy.
 */
export function reclaimPlayer(room: Room, nick: string): Player {
  const key = normalizeNick(nick).toLocaleLowerCase('pl');
  const same = room.players.filter((p) => p.nick.toLocaleLowerCase('pl') === key);
  if (same.length === 0) throw new GameError('GAME_STARTED');
  const p = same.find((x) => !x.connected);
  if (!p) throw new GameError('PLAYER_ONLINE');
  p.connected = true;
  return p;
}

export function setConnected(room: Room, id: string, connected: boolean): void {
  const p = room.players.find((x) => x.id === id);
  if (p) p.connected = connected;
}

/** Usuwa gracza (wyjście lub kick). Przekazuje rolę gospodarza. Zwraca true, gdy pokój jest pusty. */
export function removePlayer(room: Room, id: string): boolean {
  room.players = room.players.filter((p) => p.id !== id);
  if (room.players.length === 0) return true;
  if (room.hostId === id) room.hostId = (room.players.find((p) => p.connected) ?? room.players[0]!).id;
  delete room.secrets[id];
  // Gracz z aktywną turą wyszedł: wymuszamy koniec tury, przejmie to tick().
  if (room.phase === 'round' && room.activeId === id) room.deadline = 0;
  return false;
}

export function kick(room: Room, hostId: string, targetId: string): void {
  if (room.hostId !== hostId) throw new GameError('NOT_HOST');
  if (room.phase !== 'lobby') throw new GameError('GAME_STARTED');
  if (targetId === hostId) throw new GameError('CANNOT_KICK_SELF');
  removePlayer(room, targetId);
}

export function updateSettings(room: Room, hostId: string, input: Partial<Settings>): void {
  if (room.hostId !== hostId) throw new GameError('NOT_HOST');
  if (room.phase !== 'lobby') throw new GameError('GAME_STARTED');
  const next = normalizeSettings({ ...room.settings, ...input });
  if (next.maxPlayers < room.players.length) throw new GameError('TOO_MANY_PLAYERS');
  room.settings = next;
}

/* ---------- Tury ---------- */

/** Czy gracz może dostać turę: jest w pokoju, online, nie odgadł hasła i nie wyczerpał limitu pytań. */
function eligible(room: Room, id: string): boolean {
  const p = room.players.find((x) => x.id === id);
  const s = room.secrets[id];
  return !!p && p.connected && !!s && !s.solved && s.turns < room.settings.maxTurns;
}

/** Indeks następnego uprawnionego gracza, licząc od `from` (cyklicznie), albo -1. */
function pickNext(room: Room, from: number): number {
  const n = room.order.length;
  for (let i = 0; i < n; i++) {
    const idx = (from + i) % n;
    if (eligible(room, room.order[idx]!)) return idx;
  }
  return -1;
}

function startTurn(room: Room, idx: number, now: number): void {
  room.cursor = idx;
  room.activeId = room.order[idx]!;
  // Bez limitu: deadline = Infinity (nigdy nie mija), do klienta idzie jako null (patrz viewFor).
  room.deadline = room.settings.turnSeconds > 0 ? now + room.settings.turnSeconds * 1000 : Number.POSITIVE_INFINITY;
  room.turnId += 1;
}

function endRound(room: Room, now: number): void {
  room.phase = 'reveal';
  room.activeId = null;
  room.deadline = null;
  room.revealDeadline = now + REVEAL_MS;
  room.lastResult = {
    round: room.round,
    entries: room.order.filter((id) => room.secrets[id]).map((id) => {
      const s = room.secrets[id]!;
      const p = room.players.find((x) => x.id === id)!;
      return { id, word: s.word, solved: p.roundGained > 0, gained: p.roundGained };
    }),
  };
}

/** Przekazuje turę kolejnemu graczowi albo kończy rundę, gdy nikt już nie może zgadywać. */
function advance(room: Room, now: number): void {
  const idx = pickNext(room, room.cursor + 1);
  if (idx < 0) endRound(room, now);
  else startTurn(room, idx, now);
}

function beginRound(room: Room, now: number, rng: Rng): void {
  room.round += 1;
  room.lastResult = null;
  room.revealDeadline = null;
  for (const p of room.players) p.roundGained = 0;
  room.order = room.order.filter((id) => room.players.some((p) => p.id === id));
  // Każdy gracz dostaje inne hasło; hasła nie powtarzają się, dopóki starcza puli.
  let available = room.pool.filter((w) => !room.used.has(w));
  if (available.length < room.order.length) { room.used.clear(); available = [...room.pool]; }
  room.secrets = {};
  for (const id of room.order) {
    const word = available.splice(Math.floor(rng() * available.length), 1)[0]!;
    room.used.add(word);
    room.secrets[id] = { word, solved: false, turns: 0, gained: 0 };
  }
  room.phase = 'round';
  const idx = pickNext(room, (room.round - 1) % Math.max(1, room.order.length)); // rundę zaczyna kolejna osoba
  if (idx < 0) endRound(room, now);
  else startTurn(room, idx, now);
}

export function startGame(room: Room, hostId: string, now: number, rng: Rng = Math.random): void {
  if (room.hostId !== hostId) throw new GameError('NOT_HOST');
  if (room.phase !== 'lobby') throw new GameError('GAME_STARTED');
  if (room.players.length < 2) throw new GameError('NOT_ENOUGH_PLAYERS');
  room.pool = buildPool(room.settings.categories, room.settings.customWords);
  if (room.pool.length < room.players.length) throw new GameError('NOT_ENOUGH_WORDS');
  room.used = new Set();
  room.order = room.players.map((p) => p.id);
  room.round = 0;
  room.turnId = 0;
  room.cursor = 0;
  for (const p of room.players) { p.score = 0; p.correct = 0; }
  beginRound(room, now, rng);
}

function assertTurn(room: Room, playerId: string, turnId: number, now: number): void {
  if (room.phase !== 'round' || room.deadline === null) throw new GameError('NO_ACTIVE_ROUND');
  if (playerId !== room.activeId) throw new GameError('NOT_ACTIVE_PLAYER');
  if (now >= room.deadline) throw new GameError('TIME_UP');
  if (turnId !== room.turnId) throw new GameError('STALE_TURN'); // podwójne kliknięcie / stare zdarzenie
}

export interface GuessResult {
  correct: boolean;
  gained: number;
  word: string | null; // ujawnione tylko po trafieniu
}

/**
 * Aktywny gracz zgaduje swoje hasło. Trafienie: +1 punkt i nowe hasło na czole.
 * Niezależnie od wyniku (trafienie czy pudło) jego tura kończy się od razu
 * i przechodzi do następnego gracza. Każde zgadnięcie liczy się do limitu tur.
 */
export function guess(room: Room, playerId: string, turnId: number, text: string, now: number): GuessResult {
  assertTurn(room, playerId, turnId, now);
  const s = room.secrets[playerId]!;
  const typed = foldWord(text);
  const correct = typed !== '' && typed === foldWord(s.word);
  const guessedWord = s.word;

  if (correct) {
    const p = room.players.find((x) => x.id === playerId)!;
    p.score += 1;
    p.correct += 1;
    p.roundGained += 1;

    const next = drawNextWord(room);
    if (next) {
      // Nowe hasło na kolejną turę gracza; ta tura właśnie się kończy.
      room.secrets[playerId] = { word: next, solved: false, turns: s.turns + 1, gained: 0 };
    } else {
      // Pula wyczerpana — gracz kończy rundę bez nowego hasła.
      s.solved = true;
      s.gained = 1;
      s.turns += 1;
    }
    advance(room, now);
    return { correct: true, gained: 1, word: guessedWord };
  }

  // Pudło: tura przepada, przechodzi do następnego gracza.
  s.turns += 1;
  advance(room, now);
  return { correct: false, gained: 0, word: null };
}

/** Aktywny gracz zadał swoje pytanie i oddaje turę. */
export function endTurn(room: Room, playerId: string, turnId: number, now: number): void {
  assertTurn(room, playerId, turnId, now);
  room.secrets[playerId]!.turns += 1;
  advance(room, now);
}

/** Wywoływane przez timer serwera: koniec czasu tury, rozłączony lub usunięty gracz. Zwraca true, jeśli stan się zmienił. */
export function tick(room: Room, now: number): boolean {
  if (room.phase !== 'round' || room.deadline === null) return false;
  const active = room.players.find((p) => p.id === room.activeId);
  const timeUp = now >= room.deadline;
  if (!timeUp && active?.connected) return false;
  const s = room.activeId ? room.secrets[room.activeId] : undefined;
  if (s && timeUp) s.turns += 1; // przegrany czas to wykorzystana tura; rozłączenie nic nie kosztuje
  if (room.players.length < 2) endRound(room, now);
  else advance(room, now);
  return true;
}

export function nextRound(room: Room, hostId: string, now: number, rng: Rng = Math.random): void {
  if (room.hostId !== hostId) throw new GameError('NOT_HOST');
  if (room.phase !== 'reveal') throw new GameError('NO_REVEAL');
  if (room.round >= room.settings.rounds || room.players.length < 2) {
    room.phase = 'finished'; room.activeId = null; room.revealDeadline = null; return;
  }
  beginRound(room, now, rng);
}

export function winners(room: Room): string[] {
  const max = Math.max(...room.players.map((p) => p.score));
  return room.players.filter((p) => p.score === max).map((p) => p.id);
}

/**
 * Jedyny sposób wysyłania stanu do klienta.
 * Hasło gracza jest ukryte tylko przed nim samym (do czasu odgadnięcia lub końca rundy).
 */
export function viewFor(room: Room, viewerId: string): RoomView {
  const board: Record<string, BoardEntry> = {};
  if (room.phase === 'round' || room.phase === 'reveal') {
    for (const [id, s] of Object.entries(room.secrets)) {
      const visible = room.phase === 'reveal' || s.solved || id !== viewerId;
      board[id] = { word: visible ? s.word : null, solved: s.solved, turns: s.turns };
    }
  }
  const { customWords, ...rest } = room.settings;
  return {
    code: room.code, hostId: room.hostId, players: room.players,
    settings: { ...rest, customWordsCount: customWords.length },
    phase: room.phase, round: room.round, totalRounds: room.settings.rounds,
    activeId: room.activeId, turnId: room.turnId, deadline: Number.isFinite(room.deadline) ? room.deadline : null, board,
    lastResult: room.lastResult,
    winners: room.phase === 'finished' ? winners(room) : [],
  };
}

export function resetToLobby(room: Room, hostId: string): void {
  if (room.hostId !== hostId) throw new GameError('NOT_HOST');
  if (room.phase !== 'finished') throw new GameError('NO_FINISHED_GAME');
  room.phase = 'lobby'; room.round = 0; room.activeId = null; room.cursor = 0; room.turnId = 0;
  room.secrets = {}; room.order = []; room.deadline = null; room.revealDeadline = null; room.lastResult = null;
  for (const p of room.players) { p.score = 0; p.correct = 0; p.ready = false; }
}

function drawNextWord(room: Room): string | null {
  let available = room.pool.filter((w) => !room.used.has(w));
  if (available.length === 0) { room.used.clear(); available = [...room.pool]; }
  if (available.length === 0) return null;
  const word = available[Math.floor(Math.random() * available.length)]!;
  room.used.add(word);
  return word;
}