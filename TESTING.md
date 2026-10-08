# Testing og klargjøring før spillkveld

## Automatiske tester (kjører på PC-en, rører ikke dine ekte data)

```
npm test                          75 tester (spillregler, API, lagring, sikkerhet, dobbel-ruter) ca. 1 minutt
npm run load                      lasttest: 30 simulerte telefoner spiller et helt brett + kaos
npm run load -- --players 60      flere telefoner
npm run load -- --minutes 30      soak: 20 telefoner over lang tid (sjekker minnelekkasje)
```

Testene starter en egen server på tilfeldig port med en midlertidig datamappe (`DATA_DIR`), så `data/` med dine
brett og lag er urørt. Lasttesten skriver resultatet til `test/load-report.txt` og avslutter med feilkode hvis noe brytes.

**Hva lasttesten gjør:** simulerte lag buzzer samtidig (0–50 ms jitter), svarer riktig/feil/stjeler, flipper brett.
Underveis: 15 % av telefonene «sovner» (brå frakobling) før hver rute, alle kobler fra og til samtidig hver 5. rute,
spammere, søppelmeldinger, forsøk på å stjele et lagnavn, og serveren drepes (SIGKILL) midt i spillet og startes på nytt.
Etter hver rute sjekkes: nøyaktig én svarer, alle klienter ser nøyaktig samme tilstand, poengsummene stemmer med
hva admin har gjort, ingen døde tilkoblinger, ingen uventede feil i serverloggen.

### Siste resultater (denne PC-en, alt på samme maskin)

| Spillere | «Buzzer åpnet» hos alle (p95) | «Buzz → låst» (p95) | Resultat |
|---------:|------------------------------:|--------------------:|----------|
| 30       | 5 ms                          | 5 ms                | OK       |
| 60       | 98 ms                         | 37 ms               | OK       |
| 120      | 711 ms                        | 412 ms              | Ingen feil, men over 500 ms-grensen |

Soak (4 min, 20 spillere): stabilt minne (59 → 64 MB), ingen brudd. Kjør `--minutes 30` før et stort arrangement.

## Fant og fikset under testing
- En enkelt ugyldig melding (`null`) kunne krasje hele serveren.
- Et lag-id på `__proto__` kunne forurense serverens objekter.
- `board.json` ble overskrevet med standardbrett hvis filen var skadet. Nå lagres den skadde filen
  (`board.json.corrupt-…`), og `board.json.bak` brukes.
- Lagring skrev rett til filen (kunne bli halv ved krasj). Nå skrives det atomisk.
- Admin-trykk på Riktig/Feil kunne gi poeng til feil lag hvis noen buzzet akkurat da. Nå ignoreres et utdatert trykk.
- Serveren starter nå på nytt av seg selv hvis den skulle stoppe (`start.bat`), og feil gir JSON-svar.

## Sjekkliste: før dere reiser
- [ ] Bytt passord: legg `set "ADMIN_PASSWORD=noe-hemmelig"` i `start.bat` rett før `:loop`. **Med anførselstegn**, ellers blir et
      eventuelt mellomrom på slutten av linjen en del av passordet. (Etter 5 feil passord på ett minutt låses innlogging en stund.)
- [ ] Kopier hele `data/`-mappen til minnepinne/sky. Eksporter brettene (Rediger brett → Eksporter JSON).
- [ ] PC: slå av hvilemodus og skjermsparer (Innstillinger → System → Strøm), koble til lader, lukk tunge programmer.
- [ ] Test at dobbeltklikk på `start.bat` fra kald start åpner admin og storskjerm.
- [ ] Ha adressen klar som tekst/utskrift for de som ikke får skannet QR.
- [ ] **Test Windows Mobil-hotspot hjemme** (Innstillinger → Nettverk → Mobil-hotspot) og at telefonene kommer inn på `/play` via den. Det er reserveplanen hvis lokalets Wi-Fi isolerer enhetene.

## Sjekkliste: på stedet (nytt nettverk)
1. [ ] Koble PC-en til lokalets Wi-Fi/ruter og start `start.bat`. Når Windows spør om brannmur: **Tillat** (Privat og offentlig).
2. [ ] Sjekk adressen i terminalen (`192.168…` eller `10…` på Wi-Fi-kortet, ikke et virtuelt kort). **Last `/display` på nytt** etter at nettverket er byttet, så QR-koden får ny adresse.
3. [ ] Test med **én** telefon før gjestene kommer: skann QR, bli med, buzz. Feiler det: åpne «Får ikke mobilen kontakt?» i admin.
       Vanligste årsak er gjestenett/klientisolasjon → bruk Mobil-hotspot-planen.
4. [ ] Telefonene: mobildata og VPN av. Test **både iPhone (Safari) og Android (Chrome)**.
5. [ ] Lås skjermen 30 s og lås opp: telefonen skal koble til igjen av seg selv innen ca. 15 s. Bytt app og tilbake. Test lavstrømsmodus.
6. [ ] Generalprøve med 5–10 faktiske telefoner: 3–4 ruter inkl. feil svar og stjeling, flipp brett.
7. [ ] Restart-test: lukk server-vinduet midt i en runde, dobbeltklikk `start.bat`. Lagene skal komme tilbake med poeng
       (et åpent spørsmål må velges på nytt).
8. [ ] Admin fra mobil som reserve: logg inn på `/admin` fra egen telefon og prøv knappene nederst.

## Under spillet
- Lagre jevnlig et skjermbilde av poengtavlen som siste utvei.
- «Nullstill brett» beholder lag og poeng. «Nullstill alt» tømmer alt.
- Hvis serveren hang: lukk vinduet og kjør `start.bat` igjen. Tilstanden er lagret på disk.
- Hvis en telefon mister kontakten, kobler den til igjen av seg selv. Laget beholder poengene (id lagres i telefonen).
  Ny telefon: skriv samme lagnavn, så overtar den laget (hvis det er frakoblet).

## Kjente begrensninger
- Over ca. 100 samtidige telefoner begynner reaksjonstiden å øke merkbart (alle får full tilstand ved hver endring).
- Et åpent spørsmål huskes ikke over en serverrestart (det må velges på nytt).
- Admin-innloggingen krever å logge inn igjen etter restart.
- Storskjermen er ikke passordbeskyttet: hvis en spiller åpner `/display` på sin egen telefon, får den se video-ID-en til
  YouTube-rutene (og kan dermed slå opp sangen). Spill med venner trenger ikke dette, men si fra hvis dere ser juks.
- Ikke legg til sikkerhetsheadere som `Referrer-Policy: no-referrer`: YouTube-avspillingen slutter da å virke (feil 153).

## YouTube-ruter (sanger)
- Legg inn en YouTube-lenke på en rute under «Rediger brett» (🎵 YouTube-raden). Start- og sluttid i sekunder er valgfrie.
  «Skjul videoen til svaret vises» viser en ♪-boks i stedet for bildet, så tittelen ikke røper svaret.
- Spilles kun på storskjermen. Den trenger **internett** og at du har trykket **«Slå på lyd»** øverst til høyre.
  Spillerne får aldri video-ID-en (de ser «🎵 Hør på storskjermen»).
- Admin styrer med ▶ Spill / ⏸ Pause / ⟲ Fra start. Musikken pauses automatisk når noen buzzer.
- **Mange musikkvideoer kan ikke bygges inn** (feilkode 101/150: label-kanaler som VEVO m.fl.). Admin og storskjerm viser da en
  advarsel. Velg en opplasting som tillater innebygging (f.eks. «lyrics»- eller «audio»-versjoner), og **test hver sang på forhånd**.
- Hvis dere spiller uten internett på PC-en, fungerer ikke YouTube-rutene. Last da heller opp lydfil (kommer ikke per rute ennå).

## Dobbel poengsum-ruter (⭐)
- Noen få skjulte ruter per brett (standard 2, kan settes til 0–5 i admin under «Tid») er verdt **dobbelt**: riktig svar gir +2×,
  feil svar gir −2×, og andre kan fortsatt stjele. Plasseres tilfeldig (aldri øverste rad) og lagres, så de ligger fast selv om
  serveren startes på nytt. Hvert brett har sine egne.
- Spillerne og storskjermen får ikke vite hvor de ligger før ruten velges. Da vises «⭐ Dobbel poengsum ×2 ⭐» og en fanfare.
  Admin ser en ⭐ på rutene (hvis du deler admin-skjermen på TV-en, avslører den dem).
- Velg antall **før** dere starter: endrer du det underveis, plasseres de gjenværende på nytt blant rutene som ikke er brukt.
- «Nullstill brett» trekker nye tilfeldige plasseringer.