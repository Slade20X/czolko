export type Phase = 'lobby' | 'round' | 'reveal' | 'finished';

export interface Settings {
  maxPlayers: number;
  rounds: number;
  turnSeconds: number; // czas na jedną turę (pytanie)
  maxTurns: number; // limit tur (pytań) na gracza w jednej rundzie
  categories: string[]; // klucze z data/words.ts lub 'all' / 'custom'
  customWords: string[];
}

export interface Player {
  id: string;
  nick: string;
  connected: boolean;
  ready: boolean;
  score: number;
  correct: number;
  roundGained: number;
}

/** Tajne hasło gracza w bieżącej rundzie - TYLKO po stronie serwera. */
export interface Secret {
  word: string;
  solved: boolean;
  turns: number; // zakończone tury (pytania, pudła, timeouty)
  gained: number;
}

export interface RoundEntry {
  id: string;
  word: string;
  solved: boolean;
  gained: number;
}

export interface RoundResult {
  round: number;
  entries: RoundEntry[];
}

/** Pełny stan pokoju - TYLKO po stronie serwera. */
export interface Room {
  code: string;
  hostId: string;
  players: Player[];
  settings: Settings;
  phase: Phase;
  round: number;
  order: string[]; // kolejność tur
  cursor: number; // indeks aktywnego gracza w order
  activeId: string | null;
  turnId: number; // zabezpieczenie przed starymi / podwójnymi zdarzeniami
  secrets: Record<string, Secret>; // playerId -> hasło na czole
  pool: string[];
  used: Set<string>;
  deadline: number | null; // koniec bieżącej tury
  revealDeadline: number | null; // koniec ekranu podsumowania rundy
  lastResult: RoundResult | null;
}

export interface BoardEntry {
  word: string | null; // null = hasło widzą wszyscy oprócz jego właściciela
  solved: boolean;
  turns: number;
}

/** Stan wysyłany do konkretnego klienta. */
export interface RoomView {
  code: string;
  hostId: string;
  players: Player[];
  settings: Omit<Settings, 'customWords'> & { customWordsCount: number };
  phase: Phase;
  round: number;
  totalRounds: number;
  activeId: string | null;
  turnId: number;
  deadline: number | null;
  board: Record<string, BoardEntry>;
  lastResult: RoundResult | null;
  winners: string[];
}