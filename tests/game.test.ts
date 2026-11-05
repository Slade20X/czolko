import { describe, it, expect } from 'vitest';
import {
  createRoom, joinRoom, startGame, guess, endTurn, tick, nextRound, viewFor, removePlayer, kick,
  setConnected, updateSettings, GameError, REVEAL_MS,
} from '../server/game';
import { buildPool, foldWord, CATEGORIES } from '../data/words';

const rng = () => 0; // deterministycznie: p1 dostaje pool[0], p2 pool[1], p3 pool[2]...
function setup(n = 3, settings = {}) {
  const room = createRoom('p1', 'Ala', { rounds: 2, turnSeconds: 30, maxTurns: 3, ...settings }, new Set());
  for (let i = 2; i <= n; i++) joinRoom(room, `p${i}`, `Gracz${i}`);
  return room;
}
const code = (fn: () => void) => { try { fn(); } catch (e) { return (e as GameError).code; } return null; };
const word = (r: ReturnType<typeof setup>, id: string) => r.secrets[id]!.word;

describe('pokój', () => {
  it('tworzy pokój z 6-znakowym kodem i gospodarzem', () => {
    const r = setup(1);
    expect(r.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(r.hostId).toBe('p1');
  });
  it('odrzuca gracza, gdy pokój pełny', () => {
    const r = setup(2, { maxPlayers: 2 });
    expect(code(() => joinRoom(r, 'p3', 'X'))).toBe('ROOM_FULL');
  });
  it('odrzuca duplikat i dołączanie po starcie', () => {
    const r = setup(2);
    expect(code(() => joinRoom(r, 'p2', 'X'))).toBe('ALREADY_JOINED');
    startGame(r, 'p1', 0, rng);
    expect(code(() => joinRoom(r, 'p9', 'X'))).toBe('GAME_STARTED');
  });
  it('waliduje nick', () => {
    expect(code(() => joinRoom(setup(1), 'p2', '   '))).toBe('INVALID_NICK');
  });
  it('przekazuje rolę gospodarza', () => {
    const r = setup(3);
    removePlayer(r, 'p1');
    expect(r.hostId).toBe('p2');
  });
  it('tylko gospodarz może wyrzucać i zmieniać ustawienia', () => {
    const r = setup(3);
    expect(code(() => kick(r, 'p2', 'p3'))).toBe('NOT_HOST');
    expect(code(() => updateSettings(r, 'p2', { rounds: 5 }))).toBe('NOT_HOST');
    kick(r, 'p1', 'p3');
    expect(r.players).toHaveLength(2);
  });
  it('ustawienia: niepoprawny czas tury wraca do domyślnego, brakujące pola nie psują', () => {
    const r = setup(2);
    updateSettings(r, 'p1', { turnSeconds: 7, categories: undefined, maxTurns: NaN });
    expect(r.settings.turnSeconds).toBe(30);
    expect(r.settings.categories).toEqual(['all']);
  });
});

describe('hasła na czole', () => {
  it('start: każdy ma inne hasło, zaczyna pierwszy gracz', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    const words = ['p1', 'p2', 'p3'].map((id) => word(r, id));
    expect(new Set(words).size).toBe(3);
    expect(r.activeId).toBe('p1');
    expect(r.phase).toBe('round');
  });
  it('gracz nie widzi swojego hasła, ale widzi cudze', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    const v = viewFor(r, 'p1');
    expect(v.board.p1!.word).toBeNull();
    expect(v.board.p2!.word).toBe(word(r, 'p2'));
    expect(v.board.p3!.word).toBe(word(r, 'p3'));
    expect(JSON.stringify(v)).not.toContain(word(r, 'p1'));
    expect(viewFor(r, 'p2').board.p1!.word).toBe(word(r, 'p1'));
  });
  it('nie wycieka haseł własnych w ustawieniach ani cudzych dla właściciela', () => {
    const r = setup(2, { categories: ['custom'], customWords: ['tajne', 'sekret'] });
    startGame(r, 'p1', 0, rng);
    expect(word(r, 'p1')).toBe('tajne');
    const json = JSON.stringify(viewFor(r, 'p1'));
    expect(json).not.toContain('tajne');
    expect(json).toContain('sekret'); // hasło p2 widzi p1
    expect('customWords' in viewFor(r, 'p1').settings).toBe(false);
  });
  it('za mało haseł dla graczy', () => {
    const r = setup(2, { categories: ['custom'], customWords: ['jedno'] });
    expect(code(() => startGame(r, 'p1', 0, rng))).toBe('NOT_ENOUGH_WORDS');
  });
});

describe('tury', () => {
  it('start wymaga gospodarza i 2 graczy', () => {
    const r = setup(1);
    expect(code(() => startGame(r, 'p1', 0))).toBe('NOT_ENOUGH_PLAYERS');
    joinRoom(r, 'p2', 'B');
    expect(code(() => startGame(r, 'p2', 0))).toBe('NOT_HOST');
  });
  it('tury idą po kolei, po jednym pytaniu', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    const order: string[] = [r.activeId!];
    for (let i = 0; i < 4; i++) { endTurn(r, r.activeId!, r.turnId, 1000); order.push(r.activeId!); }
    expect(order).toEqual(['p1', 'p2', 'p3', 'p1', 'p2']);
  });
  it('tylko aktywny gracz może działać', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    expect(code(() => endTurn(r, 'p2', r.turnId, 1))).toBe('NOT_ACTIVE_PLAYER');
    expect(code(() => guess(r, 'p2', r.turnId, 'x', 1))).toBe('NOT_ACTIVE_PLAYER');
  });
  it('odrzuca stare zdarzenie (podwójne kliknięcie)', () => {
    const r = setup(2);
    startGame(r, 'p1', 0, rng);
    const old = r.turnId;
    endTurn(r, 'p1', old, 1);
    endTurn(r, 'p2', r.turnId, 2);
    expect(code(() => endTurn(r, 'p1', old, 3))).toBe('STALE_TURN');
  });
  it('odrzuca akcję po czasie tury', () => {
    const r = setup(2);
    startGame(r, 'p1', 0, rng);
    expect(code(() => guess(r, 'p1', r.turnId, 'x', 30_000))).toBe('TIME_UP');
  });
  it('tick: kończy turę dopiero po czasie i liczy ją do limitu', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    expect(tick(r, 29_999)).toBe(false);
    expect(tick(r, 30_000)).toBe(true);
    expect(r.activeId).toBe('p2');
    expect(r.secrets.p1!.turns).toBe(1);
    expect(r.deadline).toBe(60_000);
  });
  it('tick: rozłączony gracz traci turę od razu, bez kary', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    setConnected(r, 'p1', false);
    expect(tick(r, 5)).toBe(true);
    expect(r.activeId).toBe('p2');
    expect(r.secrets.p1!.turns).toBe(0);
  });
  it('wyjście aktywnego gracza oddaje turę następnemu', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    endTurn(r, 'p1', r.turnId, 1);
    removePlayer(r, 'p2');
    expect(tick(r, 2)).toBe(true);
    expect(r.activeId).toBe('p3');
    expect(viewFor(r, 'p3').board.p2).toBeUndefined();
  });
});

describe('zgadywanie', () => {
  it('trafienie: pełna pula punktów za pierwszą turę, ignoruje wielkość liter i spacje', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    const res = guess(r, 'p1', r.turnId, `  ${word(r, 'p1').toUpperCase()} `, 1000);
    expect(res).toEqual({ correct: true, gained: 3, word: word(r, 'p1') });
    expect(r.players[0]!.score).toBe(3);
    expect(r.activeId).toBe('p2');
    expect(viewFor(r, 'p1').board.p1!.word).toBe(word(r, 'p1')); // po odgadnięciu widzi swoje hasło
  });
  it('akceptuje odpowiedź bez polskich znaków', () => {
    const r = setup(2, { categories: ['custom'], customWords: ['żółw', 'słoń'] });
    startGame(r, 'p1', 0, rng);
    expect(guess(r, 'p1', r.turnId, 'zolw', 1).correct).toBe(true);
  });
  it('pudło: brak punktów, tura przepada', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    const res = guess(r, 'p1', r.turnId, 'zupełnie coś innego', 1);
    expect(res).toEqual({ correct: false, gained: 0, word: null });
    expect(r.players[0]!.score).toBe(0);
    expect(r.secrets.p1!.turns).toBe(1);
    expect(r.activeId).toBe('p2');
  });
  it('puste zgadnięcie nie jest trafieniem', () => {
    const r = setup(2);
    startGame(r, 'p1', 0, rng);
    expect(guess(r, 'p1', r.turnId, '  !! ', 1).correct).toBe(false);
  });
  it('im później trafienie, tym mniej punktów (min. 1)', () => {
    const r = setup(2, { maxTurns: 3 });
    startGame(r, 'p1', 0, rng);
    endTurn(r, 'p1', r.turnId, 1);
    endTurn(r, 'p2', r.turnId, 2);
    expect(guess(r, 'p1', r.turnId, word(r, 'p1'), 3).gained).toBe(2);
    endTurn(r, 'p2', r.turnId, 4);
    expect(r.secrets.p2!.turns).toBe(2);
    expect(guess(r, 'p2', r.turnId, word(r, 'p2'), 5).gained).toBe(1);
  });
  it('odgadnięty gracz nie dostaje już tur', () => {
    const r = setup(3);
    startGame(r, 'p1', 0, rng);
    guess(r, 'p1', r.turnId, word(r, 'p1'), 1);
    const order: string[] = [];
    for (let i = 0; i < 4; i++) { order.push(r.activeId!); endTurn(r, r.activeId!, r.turnId, 2); }
    expect(order).toEqual(['p2', 'p3', 'p2', 'p3']);
  });
});

describe('koniec rundy i gry', () => {
  it('runda kończy się, gdy wszyscy odgadną; hasła widać każdemu', () => {
    const r = setup(2);
    startGame(r, 'p1', 0, rng);
    guess(r, 'p1', r.turnId, word(r, 'p1'), 1);
    expect(r.phase).toBe('round');
    guess(r, 'p2', r.turnId, word(r, 'p2'), 2);
    expect(r.phase).toBe('reveal');
    expect(r.revealDeadline).toBe(2 + REVEAL_MS);
    expect(r.lastResult?.entries).toEqual([
      { id: 'p1', word: word(r, 'p1'), solved: true, gained: 3 },
      { id: 'p2', word: word(r, 'p2'), solved: true, gained: 3 },
    ]);
  });
  it('runda kończy się, gdy wszyscy wyczerpią limit pytań', () => {
    const r = setup(2, { maxTurns: 1 });
    startGame(r, 'p1', 0, rng);
    endTurn(r, 'p1', r.turnId, 1);
    endTurn(r, 'p2', r.turnId, 2);
    expect(r.phase).toBe('reveal');
    const v = viewFor(r, 'p1');
    expect(v.board.p1!.word).toBe(word(r, 'p1')); // w podsumowaniu widać też własne
    expect(v.lastResult?.entries.every((e) => !e.solved)).toBe(true);
  });
  it('kolejna runda: nowe hasła, zaczyna następna osoba; po ostatniej koniec gry', () => {
    const r = setup(2, { maxTurns: 1 });
    startGame(r, 'p1', 0, rng);
    const firstWord = word(r, 'p1');
    endTurn(r, 'p1', r.turnId, 1);
    endTurn(r, 'p2', r.turnId, 2);
    expect(code(() => nextRound(r, 'p2', 3))).toBe('NOT_HOST');
    nextRound(r, 'p1', 3, rng);
    expect(r.round).toBe(2);
    expect(r.activeId).toBe('p2');
    expect(word(r, 'p1')).not.toBe(firstWord);
    expect(r.secrets.p1!.turns).toBe(0);
    endTurn(r, 'p2', r.turnId, 4);
    endTurn(r, 'p1', r.turnId, 5);
    nextRound(r, 'p1', 6, rng);
    expect(r.phase).toBe('finished');
  });
  it('wyznacza zwycięzcę i remis', () => {
    const r = setup(2, { maxTurns: 2, rounds: 1 });
    startGame(r, 'p1', 0, rng);
    guess(r, 'p1', r.turnId, word(r, 'p1'), 1); // p1 +2
    endTurn(r, 'p2', r.turnId, 2);
    endTurn(r, 'p2', r.turnId, 3); // p2 wyczerpuje limit
    nextRound(r, 'p1', 4, rng);
    expect(viewFor(r, 'p2').winners).toEqual(['p1']);
    r.players[1]!.score = 2;
    expect(viewFor(r, 'p2').winners).toEqual(['p1', 'p2']);
  });
});

describe('hasła', () => {
  it('każda kategoria ma co najmniej 30 haseł', () => {
    for (const c of Object.values(CATEGORIES)) expect(c.words.length).toBeGreaterThanOrEqual(30);
  });
  it('usuwa duplikaty i rzuca błąd przy pustej puli', () => {
    expect(buildPool(['custom'], ['Kot', ' kot ', 'KOT'])).toEqual(['Kot']);
    expect(() => buildPool(['custom'], [])).toThrow('EMPTY_POOL');
  });
  it('foldWord ignoruje wielkość liter, ogonki, spacje i interpunkcję', () => {
    expect(foldWord('Zupa  Pomidorowa')).toBe('zupapomidorowa');
    expect(foldWord('Żółć, Łódź!')).toBe('zolclodz');
    expect(foldWord('Counter-Strike 2')).toBe('counterstrike2');
  });
});