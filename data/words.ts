const w = (s: string) => s.split(',').map((x) => x.trim());

export const CATEGORIES: Record<string, { label: string; words: string[] }> = {
  zwierzeta: { label: 'Zwierzęta', words: w('pingwin,słoń,pies,żyrafa,kot,lew,tygrys,zebra,krokodyl,delfin,rekin,wieloryb,orzeł,sowa,papuga,wiewiórka,jeż,lis,wilk,niedźwiedź,kangur,koala,małpa,goryl,żółw,żaba,wąż,pająk,pszczoła,motyl') },
  jedzenie: { label: 'Jedzenie', words: w('pizza,sushi,hamburger,pierogi,spaghetti,frytki,lody,czekolada,naleśniki,bigos,żurek,kebab,tacos,sałatka,kanapka,zupa pomidorowa,rosół,jajecznica,tort,pączek,banan,arbuz,truskawka,ser,chleb,popcorn,ramen,lasagne,gofry,szarlotka') },
  przedmioty: { label: 'Przedmioty', words: w('telefon,klawiatura,lodówka,krzesło,lampa,zegarek,okulary,parasol,plecak,nożyczki,młotek,szczoteczka do zębów,pralka,telewizor,słuchawki,kubek,rower,walizka,lustro,suszarka,odkurzacz,klucze,portfel,gitara,aparat,mikrofon,latarka,zszywacz,czajnik,poduszka') },
  miejsca: { label: 'Miejsca', words: w('Paryż,szkoła,plaża,lotnisko,kino,szpital,Kraków,Gdańsk,Zakopane,Egipt,Nowy Jork,las,basen,biblioteka,supermarket,dworzec,stadion,zoo,cmentarz,Tatry,Bałtyk,Wenecja,Londyn,Tokio,pustynia,góra,wyspa,muzeum,kościół,park rozrywki') },
  filmy: { label: 'Filmy i seriale', words: w('Titanic,Shrek,Harry Potter,Gwiezdne wojny,Matrix,Incepcja,Szybcy i wściekli,Kevin sam w domu,Król Lew,Kler,Gladiator,Park Jurajski,Avatar,Breaking Bad,Wiedźmin,Gra o tron,Squid Game,Friends,Stranger Things,Zagubieni,Toy Story,Kung Fu Panda,Pułapka,Terminator,Szczęki,Forrest Gump,Joker,Mroczny Rycerz,Ranczo,Shrek 2') },
  gry: { label: 'Gry komputerowe', words: w('Minecraft,Counter-Strike 2,Fortnite,Roblox,Wiedźmin 3,FIFA,Among Us,League of Legends,Valorant,GTA V,Tetris,Pac-Man,Mario,Zelda,Pokémon,The Sims,Cyberpunk 2077,Skyrim,Overwatch,Rocket League,Dota 2,Call of Duty,Apex Legends,Terraria,Stardew Valley,Hollow Knight,Elden Ring,Dark Souls,Portal,Hearthstone') },
  sport: { label: 'Sport', words: w('piłka nożna,koszykówka,siatkówka,tenis,pływanie,boks,skoki narciarskie,szachy,golf,rugby,hokej,narciarstwo,snowboard,maraton,rzut oszczepem,wspinaczka,judo,badminton,tenis stołowy,kolarstwo,żużel,Formuła 1,bieg przez płotki,podnoszenie ciężarów,łyżwiarstwo figurowe,surfing,skok w dal,gimnastyka,wioślarstwo,szermierka') },
  ludzie: { label: 'Znani ludzie', words: w('Spider-Man,Sherlock Holmes,Robert Lewandowski,Adam Małysz,Albert Einstein,Napoleon,Michael Jackson,Elon Musk,Iga Świątek,Jan Paweł II,Mikołaj Kopernik,Maria Curie,Shakira,Cristiano Ronaldo,Leo Messi,Batman,Superman,Iron Man,Harry Potter,Darth Vader,Kleopatra,Mozart,Chopin,Pablo Picasso,Donald Tusk,Beyoncé,Eminem,Bill Gates,Mariusz Trynkiewicz,Tom Cruise,Johnny Depp') },
  muzyka: { label: 'Muzyka', words: w('gitara elektryczna,pianino,perkusja,skrzypce,koncert,orkiestra,DJ,rap,rock,disco polo,hip-hop,opera,karaoke,mikser,Spotify,festiwal,Taylor Swift,Queen,The Beatles,Metallica,Dawid Podsiadło,Quebonafide,saksofon,trąbka,flet,harfa,ukulele,chór,płyta winylowa,słuchawki bezprzewodowe') },
  internet: { label: 'Internet i memy', words: w('TikTok,YouTube,Instagram,Discord,Twitch,Wikipedia,Google,Netflix,Doge,Pepe,Rickroll,selfie,hejter,streamer,influencer,algorytm,hashtag,emoji,wifi,lajk,subskrypcja,komentarz,filmik,wyzwanie,GIF,mem,wirusowy film,live,story,podcast') },
  trudne: { label: 'Trudne hasła', words: w('demokracja,grawitacja,sprawiedliwość,nostalgia,paradoks,ironia,inflacja,dyplomacja,ewolucja,przeznaczenie,sarkazm,absurd,kompromis,déjà vu,prokrastynacja,minimalizm,biurokracja,entropia,empatia,altruizm,kryzys,reputacja,tolerancja,determinizm,metafora,asymilacja,hipokryzja,symbioza,cenzura,anarchia') },
};

export const ALL_KEYS = Object.keys(CATEGORIES);

export function normalizeWord(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Do porównywania odpowiedzi: bez wielkości liter, polskich znaków, spacji i interpunkcji. */
export function foldWord(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .toLocaleLowerCase('pl')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Pula haseł bez duplikatów (bez rozróżniania wielkości liter). Rzuca 'EMPTY_POOL' przy pustej puli. */
export function buildPool(categories: string[], customWords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const word = normalizeWord(raw);
    if (!word || word.length > 40) return;
    const key = word.toLocaleLowerCase('pl');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(word);
  };
  const keys = categories.includes('all') ? ALL_KEYS : categories;
  for (const k of keys) CATEGORIES[k]?.words.forEach(add);
  if (categories.includes('custom')) customWords.forEach(add);
  if (out.length === 0) throw new Error('EMPTY_POOL');
  return out;
}