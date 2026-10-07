# Salesforce Flow Tester

Lokaal hulpmiddel dat Salesforce Screen Flows test via de echte Salesforce-interface in Microsoft Edge,
met Playwright en TypeScript. Het herkent per scherm de velden en uploadcomponenten, vult ze in volgens een
scenario (aangevuld met reproduceerbare testdata), uploadt documenten uit een lokale map en controleert de
uitkomst. Er wordt geen Apex of andere Salesforce-metadata aangemaakt en er is geen externe AI-dienst nodig.

> **Run is geen dry run.** Een schermknop of documentupload kan al gegevens in Salesforce opslaan voordat de
> flow eindigt. Gebruik Run alleen in een sandbox of testorg, en alleen voor de org-URL's die je expliciet in
> `allowedOrgUrls` zet.

## Installatie (Windows, VS Code)

Vereist: Node.js 20.11 of nieuwer (LTS 22 aanbevolen) en Microsoft Edge. Open de map in VS Code en gebruik de terminal (PowerShell):

```powershell
cd C:\pad\naar\salesforce-flow-tester
npm install
npm run build
```

Playwright gebruikt de geïnstalleerde Edge (`channel: "msedge"`); `npx playwright install` is niet nodig.

## Snel proberen met de lokale demo

```powershell
npm run demo                     # start http://localhost:4173/flow.html (laat dit venster open)
# in een tweede terminal:
node dist/src/cli.js inspect demo/scenarios/demo-positief.json
node dist/src/cli.js run demo/scenarios/demo-positief.json
```

De demo vraagt eerst om in te loggen; iedere gebruikersnaam werkt en het wachtwoord wordt nergens gecontroleerd
of opgeslagen. Zo zie je hoe de tester op een handmatige login wacht.

## Werken met je eigen org

1. Kopieer `scenarios/voorbeeld-positief.json` naar bijvoorbeeld `scenarios/mijn-flow.local.json`
   (bestanden `*.local.json` worden niet in Git opgenomen) en vervang alle `VERVANG`-waarden.
2. Eerste keer inloggen (inclusief MFA):
   ```powershell
   npm run login -- scenarios/mijn-flow.local.json
   ```
3. Inventariseer de flow. Inspect wijzigt geen waarden, uploadt niets en klikt nergens op:
   ```powershell
   npm run inspect -- scenarios/mijn-flow.local.json
   ```
   Neem de labels uit het rapport over in je scenario.
4. Voer de flow uit:
   ```powershell
   npm run run-flow -- scenarios/mijn-flow.local.json
   ```

### Login en sessie

- De tester start Edge met een **eigen profiel** in `.edge-profile/` (instelbaar via `browser.profileDirectory`),
  los van je normale Edge-profiel. Een pad naar je gewone Edge- of Chrome-profiel wordt geweigerd.
- Bij de eerste keer, of als de sessie verlopen is, verschijnt de Salesforce-loginpagina. De terminal meldt dan
  dat je handmatig moet inloggen; de tester wacht maximaal `timeouts.loginMs` (standaard 10 minuten).
- Er worden geen wachtwoorden opgeslagen; de wachtwoordmanager van het testprofiel staat uit. Wel worden bij
  afsluiten de cookies van het testprofiel bewaard in `.edge-profile/flowtester-session.json`, omdat Edge
  Salesforce-sessiecookies anders bij het sluiten weggooit. Dat bestand geeft toegang tot je sessie: deel het
  niet en verwijder `.edge-profile/` als je de sessie wilt intrekken.
- Een verlopen sessie tijdens een run stopt de run als **geblokkeerd**; de flow wordt niet halverwege hervat.

## Scenario's

Een scenario is een JSON-bestand. De belangrijkste velden:

| Veld | Betekenis |
| --- | --- |
| `name`, `seed` | Testnaam en vaste seed voor reproduceerbare testdata en bestandskeuze |
| `startUrl` | Flow- of record-URL; relatief pad (`/flow/Mijn_Flow`) of volledige URL |
| `urlParameters` | Extra queryparameters, bijvoorbeeld `{ "recordId": "..." }` voor recordcontext |
| `allowedOrgUrls` | Org-URL's waarop Run mag draaien (verplicht voor Run). Neem ook het `lightning.force.com`-domein op als je flow daar draait |
| `flowContainer` | `{ "selector": "flowruntime-flow" }` (standaard); voeg `"frame"` toe als de flow in een iframe staat |
| `documentsDirectory` | Map met testdocumenten, bijvoorbeeld `"C:\\SalesforceFlowTester\\testdocuments"` (dubbele backslashes in JSON) |
| `autoFill` | `all` (standaard), `required` of `none`: welke velden zonder scenario-waarde automatisch worden ingevuld |
| `allowFinish` | Of Finish/Voltooien mag worden aangeklikt (standaard `false`) |
| `maxSteps`, `timeouts` | Maximaal aantal schermen en begrensde wachttijden in ms |
| `locale` | `dateFormat` en `timeFormat` zoals de Salesforce-gebruiker ze ziet (bijv. `d-M-yyyy`, `HH:mm`) |
| `navigation` | Knopteksten voor volgende, vorige en finish |
| `screens` | Per scherm: `match`, `fields`, `uploads`, `expect` en `action` |
| `expectedOutcome` | Verwachte einduitkomst: `finished`, `screen` of `validationError` |
| `knownNamespaces` | Zelf bijgehouden eigenaar/package per namespace van custom componenten |
| `reporting` | `directory` en `maskValues` (standaard `true`) |

Schermen worden gekoppeld met `"match": { "step": 2 }` of `"match": { "text": "Documenten" }`.

Velden worden aangewezen met het label zoals Inspect het toont. Bij dubbele labels gebruik je `occurrence`
(1 = eerste op het scherm):

```json
"fields": [
  { "label": "Klanttype", "value": "Zakelijk" },
  { "label": "Telefoon", "occurrence": 2, "value": "0201234567" },
  { "label": "Interesses", "value": ["Advies", "Training"] },
  { "label": "Akkoord", "value": true },
  { "label": "Ingangsdatum", "value": "2026-11-01" },
  { "label": "Opmerking", "value": "Nieuwe tekst", "overwrite": true },
  { "label": "Account", "lookup": { "search": "Acme", "select": "Acme BV" } },
  { "label": "Interne notitie", "skip": true }
]
```

Regels bij het invullen:

- Scenario-waarden gaan altijd voor. Een ISO-datum (`2026-11-01`) wordt omgezet naar `locale.dateFormat`.
- Velden die al een waarde hebben worden alleen overschreven met `"overwrite": true`.
- Zonder scenario-waarde kiest de tester een passende waarde op basis van type, label en zichtbare beperkingen
  (maximale lengte, min/max, eenvoudige patronen). Radio- en checkboxgroepen en picklists krijgen één keuze;
  optionele losse checkboxes worden niet aangevinkt.
- Lookups worden nooit automatisch gekozen. Geef `search` en `select`; bij nul of meerdere passende resultaten
  wordt het veld als onopgelost gemeld.
- Onbekende of niet betrouwbaar invulbare velden (wachtwoorden, onherkende componenten, onvervulbare patronen)
  worden gemeld als onopgelost en krijgen geen willekeurige waarde.
- Na iedere wijziging wordt het scherm opnieuw gelezen, zodat conditionele en afhankelijke velden meegaan.

### Controles en uitkomst

- `screens[].expect.texts`: teksten die op dat scherm moeten staan.
- `screens[].expect.errors`: validatiefouten die op dat scherm moeten verschijnen (negatieve test).
- `expectedOutcome`:
  - `{ "type": "finished", "texts": ["Bedankt"] }` – vereist `allowFinish: true`.
  - `{ "type": "screen", "texts": ["Controleer uw aanvraag"] }` – stopt zodra dit scherm is bereikt.
  - `{ "type": "validationError", "errors": ["..."] }` – een verwachte validatiefout is dan een geslaagde test.

Resultaat per uitvoering:

| Status | Betekenis |
| --- | --- |
| Geslaagd | Alle expliciete controles zijn gehaald |
| Mislukt | Een controle faalt, of er trad een onverwachte validatiefout, flowfout of uploadfout op |
| Geblokkeerd | Een veld, lookup, upload of navigatie kon niet betrouwbaar worden afgehandeld |
| Geen eindcontrole | De uitvoering liep, maar er waren geen controles; correctheid is niet vastgesteld |

Een flow die zonder fouten tot het einde komt is dus nog niet "geslaagd": daarvoor zijn expliciete controles nodig.

## Documenten uploaden

Zet `documentsDirectory` naar een map met testdocumenten, bijvoorbeeld `C:\SalesforceFlowTester\testdocuments`.

- Alleen gewone bestanden direct in die map worden gebruikt. Submappen, symlinks/junctions, verborgen bestanden
  en Office-tijdelijke bestanden (`~$...`) worden overgeslagen; bestandsnamen in scenario's mogen geen pad bevatten.
- Bestanden worden alleen gelezen, nooit verplaatst, gewijzigd of verwijderd.
- De willekeurige keuze gebruikt de seed van het scenario. Kandidaten worden eerst op naam gesorteerd, dus dezelfde
  seed en dezelfde map geven dezelfde bestanden.
- Toegestane typen komen uit het `accept`-attribuut van het component; maximale grootte en aantal alleen als ze
  zichtbaar op het scherm staan of in het scenario zijn ingesteld. Ze worden niet geraden.

```json
"uploads": [
  { "label": "Bijlagen", "count": 2, "extensions": [".pdf"], "maxSizeBytes": 5000000, "expect": "success" },
  { "label": "Identiteitsbewijs", "files": ["paspoort-test.pdf"] },
  { "label": "Bijlage", "files": ["notities.md"], "expect": "error", "expectedError": "niet toegestaan" },
  { "label": "Bijlage", "invalid": "size", "expect": "error" },
  { "label": "Optioneel document", "skip": true }
]
```

Ongeldige of te grote bestanden worden alleen gebruikt als de upload `"expect": "error"` heeft. Een upload geldt pas
als geslaagd na een waarneembare bevestiging: een uploadvenster met "N of N files uploaded" (of de Nederlandse
variant), gevolgd door de bevestigingsknop (`uploadDialog.confirmButtons`, standaard Done/Gereed/Klaar), of de
bestandsnamen in het component zelf. Zonder bevestiging binnen `timeouts.uploadMs` is de uitkomst **onzeker** en
wordt de upload niet herhaald, om dubbele bestanden te voorkomen. Een ontbrekende of lege map, een ontbrekend
scenario-bestand of te weinig geschikte bestanden geeft **geblokkeerd** met de reden erbij.

## Rapporten

Iedere Inspect of Run maakt een map `reports/<tijdstip>-<scenario>-<modus>/` met:

- `report.html` – leesbaar rapport met status, controles, acties, uploads, meldingen en herkende schermen/velden
- `report.json` – dezelfde gegevens machineleesbaar
- `screenshots/` – een screenshot per scherm
- `trace.zip` – Playwright-trace; openen met `npx playwright show-trace reports\...\trace.zip`

Ingevulde vrije tekst wordt in de tekstrapporten gemaskeerd (`•••• (8 tekens)`); keuzes uit picklists, radio's en
checkboxes blijven zichtbaar. **Screenshots en traces tonen het echte scherm en kunnen persoonsgegevens bevatten.**
`reports/`, het browserprofiel en `*.local.json`-scenario's staan in `.gitignore`.

## Herkenning en beperkingen

- Alle interacties blijven binnen de flowcontainer (standaard `flowruntime-flow`); alleen het uploadvenster dat
  bij een upload verschijnt en de bestandsnamen toont, wordt daarbuiten gebruikt.
- Velden worden gevonden via label en toegankelijke rol. Velden zonder toegankelijk label, componenten met een
  gesloten shadow root en iframes binnen de flow worden als ontoegankelijk gemeld.
- Custom componenten worden per namespace gemeld. Eigenaar en package zijn vanuit de pagina niet te verifiëren;
  vul `knownNamespaces` aan op basis van Setup > Installed Packages. Er is geen gerichte ondersteuning voor
  specifieke custom componenten toegevoegd.

### Wat lokaal getest is en wat nog met een echte flow moet

Lokaal getest (met `npm test`) tegen het demoformulier en met unit-tests: veldherkenning binnen de container
(ook in open shadow DOM), conditionele velden, afhankelijke picklist, checkbox- en radiogroepen, multiselect,
combobox-picklist, lookup met eenduidige en meerduidige resultaten, dubbele labels, validatiefouten na invullen en
na navigeren, flowfout, Finish wel/niet toegestaan, login-wachten, reproduceerbare testdata en bestandskeuze,
uploads (enkel, meerdere, via bestandskiezer, ongeldig type, lege map), rapporten en trace.

Nog niet gevalideerd tegen een echte Salesforce-org (het demoformulier bootst het gedrag na, maar is niet
Salesforce): de exacte DOM van `lightning-combobox`, lookups/record pickers, `lightning-datepicker`,
samengestelde datum/tijd- en adresvelden, `lightning-dual-listbox` (knopnamen in `dualListboxMoveButtons`),
`lightning-file-upload` en het Salesforce-uploadvenster, foutweergave van Salesforce-validatieregels, de
loginherkenning en het hergebruik van de sessie. Begin daarom met Inspect en een Run in een sandbox, en controleer
het rapport en de trace.

## Ontwikkelen

```powershell
npm run typecheck
npm test            # bouwt, start de demo en draait de tests in Edge
```

In een omgeving zonder Edge kan een andere Chromium worden gebruikt met de omgevingsvariabele
`FLOW_TESTER_CHROMIUM` (pad naar het uitvoerbare bestand).
