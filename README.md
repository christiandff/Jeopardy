# Jeopardy

Et Jeopardy-spill du kjører på din egen PC. Du styrer spillet fra en admin-side, spørsmålene vises på en storskjerm (TV eller prosjektor), og spillerne buzzer inn fra mobilen sin. Alt går over lokalt nettverk, og det trengs ingen konto eller skytjeneste.

Brukergrensesnittet er på norsk.

## Hva du får

- **Tre sider:** admin (`/admin`), storskjerm (`/display`) og spillere (`/play`).
- **Lobby med QR-kode:** spillerne skanner koden, skriver et lagnavn og er med. Lagene vises på storskjermen mens alle kommer inn.
- **Buzzer på mobilen:** den som trykker først får svare. Feil svar gir minuspoeng, og de andre kan stjele poengene.
- **Poengtavle** nederst på storskjermen, og poengsummen din på mobilen.
- **Timere** for buzz-tid og svartid, med nedtelling og lydeffekter.
- **Dobbel poengsum:** noen få skjulte, tilfeldig plasserte ruter er verdt dobbelt.
- **Flere brett** som du flipper mellom, for eksempel en vanlig runde og en dobbel runde.
- **Brett-editor** i admin: kategorier, spørsmål, svar, poeng, bilder, YouTube-lenker og import/eksport som JSON.
- **Bilder** i både spørsmål og svar.
- **YouTube-ruter:** spill av en sang eller et klipp på storskjermen, eventuelt med skjult bilde til svaret vises.
- **Egne lydfiler** som lobby-musikk og tenkemusikk.
- **Admin fra mobil:** du kan styre hele spillet fra telefonen, så du slipper en ekstra PC.
- **Lagres til disk:** lag, poeng og brukte ruter overlever at serveren startes på nytt.
- **Automatisk gjenkobling:** en telefon som sovner eller mister nettet kommer tilbake med samme lag og poeng.

## Kom i gang

Du trenger [Node.js](https://nodejs.org) versjon 20 eller nyere.

```
git clone https://github.com/christiandff/Jeopardy.git
cd Jeopardy
npm install
npm start
```

På Windows kan du i stedet dobbeltklikke på `start.bat`. Den starter serveren, åpner admin og storskjerm, og starter serveren på nytt hvis den skulle stoppe.

Serveren skriver ut adressene når den starter:

| Side | Adresse | Brukes av |
|------|---------|-----------|
| Admin | `http://localhost:3000/admin` | deg som leder spillet |
| Storskjerm | `http://localhost:3000/display` | TV eller prosjektor |
| Spillere | `http://<PC-ens IP>:3000/play` | mobilene (vises som QR-kode) |

Passordet til admin er `admin` som standard. **Bytt det før du spiller med andre** (se Innstillinger under).

## Slik spiller du

1. Åpne `/display` på storskjermen. Der vises en QR-kode.
2. Spillerne skanner koden med mobilkameraet og skriver et lagnavn. Mobilene må være på samme nettverk som PC-en.
3. Logg inn på `/admin` og trykk **Start spillet**.
4. Velg en rute i admin. Spørsmålet vises på storskjermen og mobilene. Les det opp.
5. Trykk **Åpne buzzer**. Den som trykker først får svare muntlig.
6. Trykk **Riktig** eller **Feil**. Feil gir minuspoeng, buzzerne åpnes igjen, og andre lag kan stjele.
7. Trykk **Vis svar** og deretter **Neste spørsmål** for å gå tilbake til brettet.
8. Når brettet er ferdig trykker du **Flipp brett** for å gå til neste.

Snarveier i admin: `Mellomrom` åpner buzzer, `R` er riktig, `F` er feil, `V` viser svaret og `Esc` lukker spørsmålet.

## Regler

- **Vanlige regler:** alle kan buzze. Riktig svar gir poengene og valgretten. Feil svar trekker poengene og stenger laget ute resten av spørsmålet.
- **Dobbel poengsum:** noen skjulte ruter per brett (standard 2, kan settes til 0 til 5) er verdt dobbelt, både pluss og minus. De røpes først når ruten velges. Admin ser en stjerne på dem.
- **Husregel:** i admin kan du slå på at laget som valgte ruten får svare først, uten å buzze.
- **Timere:** tid til å buzze og tid til å svare. Settes i admin, og 0 betyr av.

## Brett og innhold

Under **Rediger brett** i admin kan du endre alt:

- Kategorier, ruter, poeng, spørsmål og svar.
- Bilde i spørsmål og i svar (png, jpg, gif eller webp, maks 10 MB).
- YouTube-lenke per rute, med valgfri start- og sluttid i sekunder.
- Flere brett (opptil 6), med eget navn.
- **Eksporter JSON** og **Importer JSON** for å ta vare på eller dele brett.

Trykk **Lagre brett** for å ta endringene i bruk. Lagring nullstiller spillet.

Første gang serveren starter lages to eksempelbrett med spørsmål på norsk, som du kan overskrive.

### YouTube-ruter

Videoen spilles bare på storskjermen, som må ha internett og lyd slått på (knappen øverst til høyre). Spillerne får aldri video-ID-en. Noen punkter å vite om:

- Mange offisielle musikkvideoer kan ikke spilles i en innebygd spiller. Admin og storskjerm viser da en advarsel. Velg en opplasting som tillater innebygging, og test hver sang på forhånd.
- Valget om å skjule bildet dekker videoen med en boks med et musikknotesymbol til svaret vises. Det er en gråsone mot YouTubes vilkår, så bruk det med omhu.
- Ikke sett `Referrer-Policy: no-referrer` hvis du legger serveren bak en proxy, for da slutter innebyggingen å virke.

## Innstillinger

Settes som miljøvariabler før serveren starter.

| Variabel | Standard | Betydning |
|----------|----------|-----------|
| `ADMIN_PASSWORD` | `admin` | Passord til admin-siden |
| `PORT` | `3000` | Port serveren lytter på |
| `DATA_DIR` | `./data` | Hvor brett, lagret spill, bilder og lyd lagres |
| `JOIN_URL` | automatisk | Overstyrer adressen i QR-koden |
| `DEFAULT_DOUBLES` | `2` | Antall dobbel-ruter per brett |

Eksempel i PowerShell:

```
$env:ADMIN_PASSWORD = "noe-hemmelig"
npm start
```

I `start.bat` bruker du anførselstegn: `set "ADMIN_PASSWORD=noe-hemmelig"`. Uten dem blir et mellomrom på slutten av linjen en del av passordet.

## Nettverk

Mobilene og PC-en må kunne snakke sammen. Hjemme er det vanligvis nok at alle er på samme Wi-Fi. Fungerer det ikke, er det oftest fordi nettverket isolerer enhetene fra hverandre (gjestenett, skolenett som eduroam og lignende).

Løsninger, i rekkefølge:

1. Åpne adressen for hånd på mobilen i stedet for å skanne QR-koden. Admin har en seksjon, **Får ikke mobilen kontakt?**, som lister alle adressene.
2. Bruk Windows Mobil-hotspot på PC-en, og la mobilene koble til den.
3. Koble PC-en og mobilene til en egen liten ruter.

Spillet trenger ikke internett, bortsett fra YouTube-rutene.

## Tester

```
npm test                       # 75 automatiske tester
npm run load                   # lasttest: 30 simulerte telefoner og et helt brett
npm run load -- --players 60   # flere telefoner
npm run load -- --minutes 30   # soak-test over tid
```

Testene starter egne servere med midlertidig datamappe og rører ikke dine ekte data. En sjekkliste for generalprøve og for spillkvelden ligger i [TESTING.md](TESTING.md).

I lokale tester på én PC svarte serveren på noen få millisekunder med 30 spillere, og uten feil med 60. Over rundt 100 samtidige telefoner begynner reaksjonstiden å øke.

## Prosjektstruktur

```
server.js          Express og WebSocket: spillregler, lagring, API
public/            admin.html, display.html, play.html, common.js, style.css
test/              automatiske tester og lasttest
data/              brett, lagret spill, bilder og lyd (lages automatisk, ligger ikke i git)
start.bat          starter serveren på Windows, med omstart ved krasj
TESTING.md         testing og sjekkliste før spillkveld
```

## Data og sikkerhet

- Alt du lager ligger i `data/`. Ta en kopi av mappen før et viktig arrangement.
- Brettfilen sikkerhetskopieres automatisk til `board.json.bak`, og en skadet fil blir lagret under et eget navn i stedet for å bli overskrevet.
- Admin krever passord, og etter fem feil forsøk på ett minutt låses innloggingen en stund.
- Alle som er på nettverket og kjenner adressen kan åpne `/play` og lage et lag. Det finnes ingen påmeldingskode.
- Storskjermen er ikke passordbeskyttet. En spiller som åpner `/display` kan se video-ID-en til YouTube-rutene.
- Serveren er laget for lokalt nettverk. Legger du den på internett, bør du bruke et sterkt passord og HTTPS.

## Teknologi

Node.js, Express 5, `ws` for WebSockets og `qrcode`. Frontend er vanlig HTML, CSS og JavaScript uten byggesteg.

## Lisens

ISC
