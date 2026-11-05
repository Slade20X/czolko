# Czółko z Ekipą

## Uruchomienie
Wymagania: Node.js 20+.
```
npm install
npm start
```
Otwórz http://localhost:3000, stwórz pokój i wyślij link `/room/KOD` znajomym.
Testy silnika gry: `npm test`.

## Gra przez internet
- Kamera i mikrofon wymagają **HTTPS** (wyjątek: localhost). Do testów ze znajomymi użyj np. `cloudflared tunnel --url http://localhost:3000` albo wdróż serwer na VPS/Railway/Fly.io za HTTPS. Serwer Socket.IO wymaga trwałego procesu Node, więc nie nadaje się na hosting serverless (Vercel/Netlify functions).
- Wideo idzie przez WebRTC (mesh, dobre dla 2–6 osób). Socket.IO służy tylko do sygnalizacji.
- STUN jest ustawiony domyślnie. Gdy ktoś nie może się połączyć (sieć komórkowa, firmowy NAT), skonfiguruj TURN w `.env` (`TURN_URL`, `TURN_USER`, `TURN_PASS`; skopiuj `.env.example`, załaduj np. `node --env-file=.env`).
- Kamerę włączasz przed wejściem do pokoju albo przyciskiem w dolnym panelu.

## Zasady
Serwer jest źródłem prawdy: losuje hasła, liczy czas i punkty, a hasło nigdy nie jest wysyłane aktywnemu graczowi. Po poprawnej odpowiedzi aktywny gracz dostaje kolejne hasło aż do końca czasu rundy.
