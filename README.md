# DitherLab

Kliensoldali dithering stúdió: a dithering nem tömörítési segédfunkció, hanem
szerkeszthető, réteges, paraméterezhető képi effekt. Minden a böngészőben fut,
a fájlok nem hagyják el a gépet — nincs backend.

```bash
npm install
npm run dev      # fejlesztői szerver
npm run build    # produkciós build (tsc -b && vite build)
npm test         # 205 teszt: unit + golden
npm run bench    # teljesítmény-mérés 4000×3000-en (percekig fut)
npm run app      # asztali alkalmazásként indítva (Electron)
npm run app:dist # telepítők Macre és Windowsra → release/
```

## Letöltés és telepítés

A kész asztali alkalmazás a `release/<verzió>/` mappába épül (`npm run app:dist`), például `release/1.0.1/`:

| Rendszer | Fájl | Megjegyzés |
|---|---|---|
| macOS (Intel és Apple Silicon) | `DitherLab-<verzió>-mac.dmg` | Nyisd meg, és húzd a DitherLab ikont az Alkalmazások mappába. |
| macOS, telepítés nélkül | `DitherLab-<verzió>-mac.zip` | Kicsomagolás után indítható. |
| Windows 10/11 (64 bit) | `DitherLab-<verzió>-Windows-Setup.exe` | Telepítő, Start menü és asztali parancsikon. |
| Windows, telepítés nélkül | `DitherLab-<verzió>-Windows-portable.zip` | Kicsomagolás után `DitherLab.exe`. |

**Első indítás.** Az alkalmazás nincs fizetős fejlesztői tanúsítvánnyal aláírva, ezért a rendszer egyszer rákérdez:

- **Mac:** ha azt írja, hogy az appot nem lehet ellenőrizni, nyisd meg a *Rendszerbeállítások → Adatvédelem és biztonság* panelt, és kattints a „Megnyitás mindenképp” gombra (régebbi macOS-en: jobb klikk az appon → Megnyitás).
- **Windows:** a „A Windows megvédte a számítógépet” ablakban kattints a „További információ”, majd a „Futtatás mindenképp” gombra.

Internet nélkül működik, a képek nem hagyják el a gépet. Az exportált fájlok alapból a Letöltések mappába kerülnek (Beállítások ⚙ → Fájlok mentése).

## Quick start (English)

DitherLab turns an image into dithered art or a print-ready T-shirt transfer. Install from `release/<version>/` as above — on first launch, Mac: *System Settings → Privacy & Security → Open Anyway*; Windows: *More info → Run anyway*. Then:

1. Drop an image into the window (or click **Open**, or paste it).
2. Pick a *Quick start* look, or click **T-shirt print (DTF) →**.
3. In the studio choose the shirt color, size and placement; the automatic settings do the rest. The banner at the top tells you when the file is ready to print.
4. **Save for printing** → *Print-ready PNG*, or *Print-shop package (ZIP)* with a mockup and a job sheet.

Every view can be dragged, zoomed (wheel, pinch, +/−, Fit, 1:1, double-click) and panned with the arrow keys; zooming in loads the real 300 DPI dots. The studio's *On background* view shows the print file on any background colour you pick.

**Help (?)** has a step-by-step DTF guide, a glossary and every keyboard shortcut. The interface is in English and Hungarian (toolbar language menu or Settings); by default it follows the system language.

## Kényelmi funkciók

- **Nyelv:** magyar és angol felület (eszköztár vagy Beállítások), alapból a rendszer nyelvét követi.
- **Kezdőképernyő:** nagy ejtőterület, mintakép, „mit szeretnél készíteni” kártyák, legutóbbi képek (csak ezen a gépen, IndexedDB-ben; kikapcsolható).
- **Súgó (?):** első lépések, lépésről lépésre DTF útmutató (mit mondj a nyomdának, otthoni préselés), 21 kifejezéses szótár kereséssel, billentyűparancsok, adatvédelem.
- **Pólóstúdió:** *Egyszerű* mód (csak a lényeg, a többit az automatikus beállítás intézi) és *Haladó* mód; felső állapotsáv („Nyomtatható” / „1 dolgot érdemes megnézni” / „javítani kell”, *Mutasd* gombbal); **Nyomdai csomag (ZIP)** egyetlen fájlban: nyomdakész PNG + makett + munkalap; megjegyzi a legutóbbi pólószínt, méretet, anyagot és elhelyezést; *Ajánlott beállítások* gomb; Esc = bezárás, ⌘/Ctrl+S = nyomdakész PNG.
- **Szitastúdió:** az összes film egy ZIP-ben, ékezetmentes fájlnevekkel.
- **Nézegető minden nézetben** (főablak, DTF stúdió, szitastúdió): húzással mozgatható, görgővel vagy csippentéssel nagyítható a kurzornál, +/− és százalékkijelző, *Igazítás* és *1:1* gomb, dupla kattintás = közeli ↔ egész kép, nyilakkal is mozgatható, nagyításnál áttekintő térkép a sarokban. A görgő szerepe (nagyítás vagy mozgatás) a Beállításokban váltható.
- **Új nézet a pólóstúdióban: „Alap háttéren”** — a nyomdai fájl egyszínű háttéren, választható színnel (pólószín, fekete, fehér, szürke vagy egyedi); a program megjegyzi a választást. Nagyításkor a *Nyomdai fájl*, az *Alap háttéren*, a *Részlet* és a *Fehér alap* nézet a valódi, teljes felbontású pontokat tölti be a látható területre, nem az előnézetet nagyítja.
- **Kép bárhová ejthető**, beilleszthető; megnyitáskor az ablakhoz igazodik (F = igazítás, 0 = 100%, dupla katt = közeli ↔ egész); az első render alatt az eredeti látszik.
- **Értesítések** mentéskor; az asztali appban „Megmutatás a mappában” gombbal.
- **Billentyűzet és akadálymentesség:** ⌘/Ctrl+O megnyitás, ⌘/Ctrl+S mentés, ⌘/Ctrl+P pólóstúdió, ⌘/Ctrl+Z visszavonás, szóköz = előtte, C = összehasonlítás, ? = súgó, Esc = bezárás; a csúszkák nyilakkal is állíthatók, a szekciók fejléce gomb, látható fókuszkeret.
- **Asztali app:** natív menü a felület nyelvén, az ablak mérete és helye megmarad, „Megnyitás ezzel” és ráhúzás a Dock-ikonra (Mac), felületméret 85–130%, választható mentési mappa, összeomlás esetén újratöltés-ajánlat.

A kép- és nyomatfeldolgozás (dither, DTF motor, ellenőrzés, hangoló) ebben a körben **nem változott**: a `src/core` és a workerek érintetlenek, a korábbi tesztek változatlanul zöldek. A magyar szövegek a magban maradtak; az angol fordítás a felületen történik (`src/i18n`), és teszt ellenőrzi, hogy minden mag-szövegnek és a valós ellenőrzési, hangolási és szitanyomási üzeneteknek van angol változata.

## Asztali alkalmazás építése

```bash
npm run app            # webes build + Electron, helyben indítva
npm run app:dist       # telepítők Macre és Windowsra a release/<verzió>/ mappába
npm run app:dist:mac   # csak Mac (universal: Intel + Apple Silicon)
npm run app:dist:win   # csak Windows (NSIS telepítő + hordozható zip)
npm run icon           # az ikon újrarajzolása (build/icon.png, public/favicon.png)
```

Az Electron héj (`electron/main.cts`, `electron/preload.cts`) csak ablakot, menüt, mentési helyet és „megnyitás ezzel” támogatást ad. A felület ugyanaz a statikus build, mint a böngészős változat, saját `app://` sémáról kiszolgálva, szigorú CSP-vel és sandboxolt rendererrel; a hálózat felé csak az opcionális Claude ellenőrzés és a Lospec paletta-import mehet. A Windows-telepítő Macen is elkészül (Wine nélkül). A Mac-es csomag ad-hoc aláírást kap (`build/adhoc-sign.cjs`), így más gépen „sérült” helyett a szokásos „Megnyitás mindenképp” kérdés jön.

## A vezérelv

**A dither felbontása és a kimenet felbontása független egymástól.** Minden
dither rétegnek van `pixelScale` paramétere: a kép leskálázódik box szűrővel,
a dither a kis rácson fut, majd nearest neighbourrel visszaskálázódik. A
részletesség összeomlik, a felbontás megmarad.

## Architektúra

```
src/core/     nulla DOM- és React-függőség — ugyanaz a kód fut főszálon,
              workerben és a tesztekben. Ez teszi a „preview = export”
              garanciát szerkezetivé, nem ígéretté.
src/workers/  render worker + kliens; a forrás pixelei egyszer töltődnek fel,
              utána csak azonosítóval hivatkozunk rájuk
src/state/    zustand store; a történet kizárólag szerializálható dokumentum-
              állapotot tárol, soha egyetlen pixelt sem
src/ui/       React felület; a paraméter-panel a ParamSchema-ból generálódik
src/io/       kép- és preset be/kimenet, saját PNG enkóder
```

A pipeline tiszta függvény: `(forrás, rétegek, kontextus) -> kép`. A
réteghatárok cache-elődnek egy 384 MB-os keretben, LRU ürítéssel — teljes
felbontású Float32 RGBA 16 bájt/pixel, tehát egy 4000×3000-es kép rétegenként
192 MB, korlát nélkül garantált tabcrash.

### Proxy előnézet — és hol nem tud pontos lenni

2000 px fölött az előnézet **egész** osztóval kisebbített forrásból számol.
A raszter geometriája ilyenkor csak azzal a résszel skálázódik, amit a
`pixelScale` összeomlása nem nyelt el (`residualDivisor`). Ebből következik:

- `pixelScale >= osztó` → a dither rács mérete **azonos** az előnézetben és a
  végleges renderben, tehát a raszter is azonos. A felület ezt zölden jelzi.
- `pixelScale < osztó` → nem tartható, és a felület ezt sárgán ki is írja
  („a raszter sűrűsége a végleges renderben eltér”), nem hazudik róla.

Ezt teszt is rögzíti: 64×64-es forrás teljes rendere és a 32×32-es proxy
rendere `pixelScale=4` mellett a cellák több mint 97%-án egyezik.

### Számítás helye

Minden CPU-n, worker poolban. A WebGL2 backend szándékosan később jön: egy
algoritmus két implementációja (GLSL + TS) két igazság, és pont a
„preview ≠ export” hibát hozná vissza. A mérés is ezt támasztja alá — a
`pixelScale` miatt az ordered dither jellemzően erősen leskálázott pufferen fut.
Ha bekerül, algoritmusonként opcionális lesz, és csak parity-teszt után.

## Ami elkészült

| | |
|---|---|
| Dither algoritmus | **44** (14 hibaterjesztés, 23 rendezett, halftone, 6 modulált) |
| Nem-dither effekt | **15** |
| Beépített paletta | **35** |
| Keverési mód | **16** |
| Paraméter összesen | **649** |
| Teszt | **109** |

A halftone egy processzor 11 pontalakkal és 3 színbontással, a modulált küszöb
egy processzor 6 modulációtípussal — variánsonként számolva ez ~59 dither.

- **Hibaterjesztés**: Floyd–Steinberg, „hibás” FS, Jarvis–Judice–Ninke, Stucki,
  Atkinson, Burkes, Sierra-3, Sierra-2, Sierra Lite, Fan, Shiau–Fan 1 és 2,
  Riemersma (Hilbert-görbe), szabadon szerkeszthető mátrix. Mindegyiken
  `serpentine`, `diffusionStrength`, `errorJitter`, `threshold`.
- **Rendezett**: Bayer 2–32, void-and-cluster (generált kék zaj), fehér zaj,
  interleaved gradient noise, tömör pont 4/6/8, spirál, bűvös négyzet,
  vonal- és keresztraszterek, átlós szövet, sakktábla, egyedi mátrix beillesztés.
- **Halftone**: CMYK csatornánkénti szöggel és LPI-vel, 11 pontalak, dot gain,
  élesség, átnyomás, papírszín.
- **Modulált**: hullám / sugárirányú / spirál / Perlin / luminancia / sodródó
  küszöb, ASCII dither, alakzat-dither, quadtree blokk-dither, szintvonal,
  élérzékeny dither.
- **Effektek**: tónus és szín, szintek, poszterizálás, invertálás, küszöb,
  szürkeárnyalat, elmosás, élesítés, bloom, CRT/scanline, zaj/szemcse,
  kromatikus aberráció, JPEG glitch, pixel sort, displacement.
- **Szín**: sRGB↔lineáris, 4 színtávolság-metrika (RGB, súlyozott RGB, CIE76,
  CIEDE2000), median cut / k-means / octree palettakinyerés, .hex/.gpl/.ase/.pal
  import, Lospec URL, kézi paletta-szerkesztő.
- **Export**: PNG, **valódi indexelt PNG** (1/2/4/8 bit a paletta méretéhez),
  WEBP, JPG, TIFF, SVG és PDF vektor, preset JSON és megosztható link.
- **Szitanyomat**: színbontás, aláfestés, nyomdai raszter, filmpozitívok —
  lásd lent.

### A JPEG glitch pontosan mit csinál

Valódi JPEG transzformációs lánc: YCbCr, 4:2:0, 8×8 DCT, kvantálás az Annex K
táblákkal az IJG minőség-képlettel skálázva, majd dekvantálás és inverz DCT.
Az entrópiakódolást (Huffman) kihagyja — az a fájlméretet határozza meg, nem a
képet. A bitfolyam-sérülést közvetlenül az együtthatókon modellezi, beleértve a
DC-prediktor elcsúszását, ami a felismerhető vízszintes színcsíkokat adja.

### Vektor export

Saját contour tracer (nem potrace). Indok: (1) a potrace GPL-2.0, ami
megfertőzné az egész appot; (2) Bézier-simítást végez, ami pont a dither-pöttyök
sarkait kerekítené le, holott hímzéshez pixelhű poligon kell; (3) a
`minPathArea` / `mergeAdjacent` / `strokeMode` a saját tracernél triviális.

Minden görbe egyetlen `<path>`-be kerül `fill-rule="evenodd"`-dal, így a lyukak
körüljárási iránytól függetlenül helyesek — Illustratorban és Inkscape-ben is.
Teszt rögzíti, hogy a vektorizált kimenet **visszaraszterizálva bitre egyezik**
a bemeneti maszkkal (1189 pixeles pszeudovéletlen dither mezőn 0 eltérés).


## Szitanyomat stúdió (Pólóra →)

Külön alprogram a főablak eszköztárából. A kiindulópont: **sötét pólón a
minta fekete része nem festék, hanem maga a póló** — ezt hívják kihagyásnak
(knockout). A stúdió ebből a feltevésből dolgozik visszafelé.

Mit csinál:

1. **Színbontás.** A képet festékenkénti fedettségre bontja. A modell szerint
   nyomtatási léptékben egy raszterezett felület úgy néz ki, mint a póló színe,
   rajta a festékpontok átlaga:
   `eredmény = póló + Σ aᵢ · (festékᵢ − póló)`, `aᵢ ≥ 0`, `Σ aᵢ ≤ 1`.
   Az `aᵢ` fedettségek visszafejtése egy kis nemnegatív legkisebb négyzetes
   feladat, **lineáris fényerőtérben** megoldva — pontokat átlagolni fényt
   átlagolni. Pixelenként ez túl lassú lenne, ezért egy 32³-as kockára
   előszámolódik, és a keresés trilineárisan interpolál benne.
2. **Raszterezés.** Minden fedettség-térkép rasztertpontokká alakul — ettől lesz
   a glow és a grain apró pöttyökből álló, nyomtatható felület a szétfolyt
   átmenet helyett. AM (szabályos, szögelt pontrács) vagy FM (sztochasztikus,
   nem tud moarét adni) raszter.
3. **Aláfestés.** A színek alá fehér alap, **szűkítve (choke)**, hogy ne
   villanjon ki fehér perem. A szűkítés a sziluettre fut, nem a tónusra.
4. **Filmek.** Szitánként egy 1 bites filmpozitív, ahol fekete = festék.

### A három dolog, ami nélkül a nyomat sáros lesz

| | |
|---|---|
| **Pontnövekedés** | A festék szétterül az anyagban, egy 50%-os pont a filmen ~70%-ként nyomódik. A film ezért kisebb pontot kap: `c = f + 2g·f·(1−f)` inverze. |
| **Tónushatárok** | A gép nem tart 6% alatti pontot (kiesik) és 90% feletti pontot (befolyik). Ami nyomódik, azt a stúdió a tartható sávba szorítja. |
| **Valódi kihagyás** | A küszöb alatti fedettség pontosan nulla lesz, nem szórt pöttyök — így a póló tisztán marad, nem szemetel a grain. |

### Beállítások és mértékek

- **Rasztersűrűség**: 35–55 LPI a textil sávja; a felület kiírja a hozzá való
  szitasűrűséget (LPI × 4–5).
- **Film felbontása**: 600 DPI az alap; a stúdió jelzi, ha egy rasztercella
  4 pixelnél kevesebb lenne.
- **Pontnövekedés**: textilen 20–30%.
- **Nyomat szélessége mm-ben** — ebből és a DPI-ből jön a film pixelmérete.

Az „Ellenőrzés" panel átnézi a beállítást és szól, ha valami nem fog menni:
túl magas LPI, tarthatatlan pont, üres szita, kevés film-felbontás.

Teljesítmény: a fedettség-kocka felépítése 56 ms (előtte 1160 volt, warm start
és trilineáris keresés hozta le), egy előnézet ~100 ms, tehát a csúszkák
élőben követhetők.

## Pólónyomat stúdió — DTF (fehér aláfestéses, rávasalós transzfer)

A főablak **Pólóra (DTF) →** gombja nyitja. Erre az eljárásra specializált: a
nyomdára/RIP-re menő, nyomdakész átlátszó PNG-t készíti el bármilyen képből,
és közben mindent ellenőriz, amit egy DTF nyomda megkérdezne.

A DTF menete röviden: a nyomtató a PET fóliára CMYK-t, majd arra **fehér
aláfestést** nyomtat, ragasztóport szórnak rá, kikeményítik, és hőpréssel
átvasalják a pólóra. A RIP a PNG alfa-csatornájából dönti el, hová tegyen fehéret.

### Mit csinál a motor, és miért

1. **Fekete kiütés (black knockout).** Sötét pólón a minta fekete része nem
   festék, hanem maga a póló. A motor minden pixelt a póló színére komponál
   lineáris fényben, majd „szín→alfa" módon visszabontja: megkeresi azt a
   legkisebb fedettséget és hozzá tartozó festékszínt, amivel a pólón ugyanaz
   a szín jön ki. A póló színéhez közeli tónusok (tolerancia alatt) teljesen
   eltűnnek, a világosak (tömör határ felett) tömören nyomódnak, a kettő
   között pontok adják a tónust. Három kiindulás: *Fotó — tömör*,
   *Kiegyensúlyozott*, *Vintage — légáteresztő*.
2. **Nincs félig átlátszó pixel.** A félig átlátszó pixel alá a RIP részleges
   fehéret tesz, ami ködös fátyolként nyomódik. Minden átmenet (glow, árnyék,
   grain, puha szél) pontokká alakul — minden pixel vagy 0, vagy 255 alfa.
3. **Raszter a cella átlagtónusából.** AM (euklideszi pont az alap: 50%
   fölött kerek lyukak, nem csillag alakú rések) vagy FM. A tónust cellánként
   átlagolja, így a szemcsés képen is ép, szabályos pontok lesznek.
4. **Hibrid világos tónusok.** A legkisebb nyomtatható pont alatt a pontok
   nem zsugorodnak tovább, hanem ritkulnak — így nem lesz porszerű, leváló pötty.
5. **Éles élek nagyításkor.** Egy 1000 px-es kép 30 cm-re nagyítva minden
   élt elmosna. Ahol a forrásban csak tömör és kiütött pixel (vagy 1–2 px-es
   élsimítás) van, ott a motor geometriailag pontos kontúrt rajzol a raszter
   helyett, a tömör alakzat saját színével.
6. **Takarítás.** Törli a nyomtathatatlan pöttyöket, betömi a tűhegynyi
   lyukakat (a szomszédos tinta színével), és eltávolítja azokat a kis
   szigeteket, amelyek alól a RIP choke-ja teljesen elviszi a fehéret —
   sötét pólón ezek láthatatlanok lennének és leválnának. Hosszú vékony
   vonalat soha nem töröl: azt jelzi.

### Ellenőrzés (teljes felbontáson, külön workerben)

Felbontás a nyomat méretén (300 DPI a szabvány; a raszterezett részekhez a
prepress 2×LPI szabálya), félig átlátszó pixelek, LPI-sáv, legkisebb pont,
**choke utáni fehér** (hány elem alól tűnik el a fehér), 0,45 mm-nél vékonyabb
tömör vonalak, elhelyezés-méret a publikált tartományokhoz, filmszélesség,
tükrözés. A „Problémák" nézet megmutatja, hol.

### Export

- **Nyomdakész PNG**: RGBA, a valós felbontás a `pHYs` chunkban (300 DPI =
  11811 pixel/méter) és `sRGB` + `gAMA` színtér-jelölés — a RIP így pontosan a
  kért centiméterméretben olvassa be. Független dekóderrel (macOS ImageIO)
  ellenőrizve.
- **TIFF alfával**: `ExtraSamples = 2` (nem előszorzott alfa), valós DPI.
- **Makett PNG** és **munkalap** (méret, elhelyezés, raszter, choke-feltevés,
  préselési adatok, ellenőrzési lista).
- **Tükrözés**: alapból nincs. DTF szolgáltatónak és RIP-nek nem kell
  tükrözött fájl — ők tükröznek.

### Számok és forrásaik

| | érték | forrás |
|---|---|---|
| Fájl | átlátszó PNG, 300 DPI, végleges méretben, RGB | [DTFSheet](https://dtfsheet.com/blogs/blog/dtf-transfer-resolution-requirements), [Sumotransfers](https://sumotransfers.com/blogs/articles-1/file-prep-for-dtf-transparent-png-white-underbase-300-dpi) |
| Fekete kiütés + halftone | a fekete a pólóból jön; átmenetek pontokként | [Transfer Superstars](https://www.transfersuperstars.com/blogs/dtf-transfer-printing/dtf-decoded-the-ultimate-guide-to-black-knockout-halftoning-graphics-for-dtf-transfer) |
| LPI | 30 a kiindulás, 35–45 kalibrált gépen, 55 fölött betömődik | [Transfer Superstars](https://www.transfersuperstars.com/blogs/dtf-graphic-design/mastering-halftone-prints-direct-to-film-printing-best-practices), [DTF Dallas](https://dtfdallas.com/blogs/news/dtf-halftone-software-photoshop-guide) |
| Legkisebb vonal/elem | 0,40–0,50 mm | [Sumotransfers](https://sumotransfers.com/blogs/articles-1/minimum-text-and-line-thickness-that-survive-in-dtf) |
| Fehér choke | 2–4 px (RIP-függő) | [DTF Transfer Studio](https://dtftransferstudio.com/white-outline-dtf-choke-settings-guide/), [DTF PrintCo](https://dtfprintco.com/rip-software-settings-for-dtf-printing-guide/) |
| Préselés szövetenként | pl. 100% pamut: 149–163 °C, 10–15 s | [DTF Database](https://dtfdatabase.com/tools/dtf-temperature-time-chart/) |
| Elhelyezés | bal mell 3,5–4,5"; elöl 9–12", 3"-re a varrástól | [ScreenPrinting.com](https://www.screenprinting.com/blogs/news/dtf-transfer-placement-guide) |
| Póló méretek | Gildan 5000 félmellbőség 18/20/22/24/26/28" | [Gildan 5000 mérettáblázat](https://cdn.inksoft.com/images/publishers/16912/ProductAttachments/1002762/GILDAN_5000.pdf) |
| Tekercsszélesség | 22" szabványos gang sheet | [WePrintUPress](https://weprintupress.com/blogs/dtf-transfer-tips/dtf-gang-sheets-how-to-create-a-dtf-gang-sheet) |

Két saját mérnöki döntés, forrás nélkül, dokumentáltan: a pont alá kell
legalább **3 px** fehér a choke után (raszterizálási tartalék a fájl
felbontásán), és a lyukkitöltés a *gyári* minimumhoz (0,45 mm) igazodik, nem a
choke miatt megnövelt ponthoz. A fehér toneres (A+B papíros) transzferhez nincs
külön mód, mert a tükrözési szabályát nem tudtam forrásból ellenőrizni.

### Ebben a körben talált és javított hibák

- Az **euklideszi pont** küszöbfüggvénye nem volt monoton (30%-nál is tintát
  tett a cellaél közepére), a **kerek pont** 78,5% fölött kevesebb tintát
  nyomott a kértnél (90% helyett ~86%). Mindkettőt a RIP-ek módszerével,
  rangtáblából számolt küszöbbel váltottam ki — a régi halftone modult is
  érintette.
- A TIFF mindig 72 DPI-t írt; most a valós felbontást.
- A betömött lyuk színét soron balra keresve vette, akár egy távoli, más
  színű pontból — most a szomszédos tintából.

## Automatikus beállítás és Claude ellenőrzés (DTF)

A stúdió minden képnél **magától beállítja** a kiütést úgy, hogy a nyomat ne
legyen „tejes". Ez helyben fut, internet és költség nélkül. Opcionálisan
**Claude** is ránéz a képre, és azokat a döntéseket hozza meg, amikhez látni
kell a képet.

### Mi a „tejes" nyomat, és hogyan méri

A RIP minden nyomott pixel alá fehér alapot tesz. A pólóhoz közeli sötét
festék fehér alapon szürkés, krétás foltként jön ki — a sötétpiros poros lesz,
a fekete szürke. Ezeket a tónusokat a pólónak kell adnia a pontok között.

A program ezt **méri**: a nyomott felület hány százalékán kerül a pólóhoz
közeli (a `MILKY_DISTANCE = 0,35` érzékelt távolságon belüli) festék fehér
alapra. A cél legfeljebb **5%**. Ugyanez az ellenőrzés fut a kész fájlon is
(„Tejes kockázat"), a Problémák nézet ciánnal mutatja, hol.

Mellette a **fehér perem** ellenőrzés: 0,08 mm (1 px) alatti choke-nál a
fehér kilátszik a színek és pontok körül — ez a másik ok, amitől egy
halftone-os nyomat fakónak tűnik.

### A hangoló

Kb. 450 beállítás-kombinációt (tolerancia × tömör határ × pontsúly) mér le a
kép kicsinyített másán, **a renderelő saját kiütési modelljével**, így a
számok azt írják le, ami ténylegesen nyomódni fog (egy teszt ezt a kész
fájlon mért értékkel veti össze). Szabály: először a tejes kockázat ≤ 5%,
azon belül a legjobb pontszám. A pontszám súlyai ízlés kérdése — ezeket a
„Tömörebb / Kiegyensúlyozott / Légáteresztőbb" választó állítja. A
rasztersűrűség a legkisebb pontból adódik: a legsűrűbb LPI, amin a pont a
cella legfeljebb 40%-át foglalja.

### Talált hiba: a pólónál sötétebb szín

A „szín→alfa" modell a pólónál *sötétebb* színekre (a minta tiszta fekete
része egy 0,055-ös fekete pólón) óriási fedettség-igényt számolt, mert a
különbséget a póló kicsi lineáris értékével osztotta. Így a minta mély fekete
részei fekete festékként, fehér alapra kerültek — pont a tejes hatás. Most
sötét pólón a festék csak világosíthat (a pólónál sötétebb szín legjobb
visszaadása maga a csupasz póló), világos pólón csak sötéteríthet, középtónusú
pólón mindkettő.

### Claude ellenőrzés (opcionális)

- **Saját Anthropic API-kulcs kell**; csak ebben a böngészőben tárolódik
  (`localStorage`), és csak az Anthropic API-nak megy.
- **Csak kifejezett beleegyezéssel küld**: az eredeti kép és a pólós
  próbanyomat egy-egy 768 px-es másolatát, plusz a mért számokat (JSON). A
  teljes felbontású kép nem hagyja el a gépet.
- Modell: `claude-opus-5`, adaptív gondolkodással, a hivatalos
  `@anthropic-ai/sdk`-val, szerkezett (JSON-séma) kimenettel.
- **Szerveroldali tartalék (`fallbacks: "default"`) bekapcsolva**: ha az
  Opus 5 egy kérést nem vállalna, az Anthropic kategória szerint választott
  tartalék modellre vált. Ha az egész lánc elutasít, a helyi beállítás marad.
- **Bízni, de ellenőrizni**: Claude javaslatát a program minden értékét a
  megengedett tartományba szorítja, majd újraméri — és csak akkor alkalmazza,
  ha nem lesz tőle tejesebb és nem tér el jobban az eredetitől. Claude
  tanácsot ad; rosszabbá nem teheti a nyomatot.
- Költség: egy ellenőrzés néhány cent (3 kicsinyített kép + rövid válasz).

## Teljesítmény (4000×3000 = 12 MP, alapértelmezett paraméterek)

| algoritmus | ms | MP/s |
|---|---|---|
| fx:glow | 2450 | 4.9 |
| fx:pixel-sort | 1706 | 7.0 |
| ed:riemersma / stucki / jarvis | ~1500 | ~8 |
| ed:floyd-steinberg | 1076 | 11.2 |
| ord:bayer8 | 964 | 12.4 |
| mod:threshold | 977 | 12.3 |
| fx:adjust | 275 | 43.6 |

Minden algoritmus a 3 másodperces kereten belül van. A `fx:glow` eredetileg
5023 ms volt; a bloom mostantól leskálázott maszkon számol, mert eleve alacsony
frekvenciás — ez négyzetes megtakarítás a pixelszámon és a kernelszélességen is.

## Tónushűség

Egy dither akkor tónushű, ha a fehér pixelek aránya a bemenet **lineáris**
luminanciájával egyezik — ezt integrálja a szem. Mért értékek (sRGB 0.5 bemenet,
elvárt 0.214):

| | lineáris fényerőtér BE | KI |
|---|---|---|
| Floyd–Steinberg | 0.213 | 0.500 |
| Bayer 8×8 | 0.219 | 0.500 |
| Kék zaj | 0.214 | 0.500 |
| Modulált küszöb | 0.214 | 0.500 |

A `gammaCorrect` alapból bekapcsolva, mert ez a helyes. Kikapcsolva a kép
világosabb lesz a bemenetnél (sRGB 0.5 → 0.735-nek látszik) — a specifikáció
szerint ez néha szebb, ezért maradt kapcsoló.

Az Atkinson szándékosan kilóg: a hiba negyedét eldobja, ettől crushed és
kontrasztos. Ezt külön teszt rögzíti, nem tónushűként.

## Ami NINCS kész

- **Videó (7. fázis)**: ffmpeg.wasm dekódolás/enkódolás, timeline, keyframe-ek,
  GIF/MP4/WEBM/APNG export. Az alapinfrastruktúra viszont áll és tesztelt: a
  `RenderContext` ismeri a `frame`-et, a `noiseMode` (`static` / `perFrame` /
  `cycling`) működik és teszt fedi.
- **Batch feldolgozás** több képre.
- **WebGL2 backend** — lásd fent, tudatos sorrendezés.
- **Görbeszerkesztő** (a Szintek réteg gammával lefedi a szükségeset).
- **Kódaláírás** (Apple Developer ID + notarizáció, Windows kódaláíró tanúsítvány) — fizetős tanúsítványok; nélkülük az első indításkor egyszer biztonsági kérdés jön.
- **Automatikus frissítés** az asztali appban.
- A Windows-változat valódi Windows gépen nincs kipróbálva: Macen épült, a csomag tartalma és az exe ikonja ellenőrizve.

### Kihagyott algoritmusok — és miért

Ezeket **nem** implementáltam, mert a publikált együttható-tábláikat nem tudom
biztosan felidézni, és a specifikáció szerint ilyenkor szólok, nem találgatok:

- **Ostromoukhov** (256 soros, változó együtthatós tábla)
- **Zhou–Fang** (Ostromoukhov táblájára épül)
- **Knuth dot diffusion** (8×8 osztálymátrix)
- **Stevenson–Arce** (12 együttható hexagonális elrendezésben)
- **Fan–Eschbach**

Ezek beilleszthetők, amint megvan az eredeti forrás — a regiszter plugin-szerű,
egy új kernel a `KERNELS` tömbbe kerül és kész.

A **Riemersma** benne van: a Hilbert-görbe bejárás egzakt, a hiba-lecsengés
pedig dokumentált, paraméterezett exponenciális görbe (`queueSize`,
`decayRatio`), nem egy konkrét konstans-tábla reprodukciója.

## Menet közben talált és javított hibák

1. `bufferToRgba` kétszer kerekített (`+0.5` egy `Uint8ClampedArray`-be), így
   minden 8 bites érték eggyel feljebb csúszott.
2. A modulált küszöb 0.5-ös bemenetre 0.003 fehér arányt adott 0.214 helyett: a
   szinusz és a Perlin zaj eloszlása nem egyenletes, így küszöbmezőként a
   középtónusokat feketére préselte. A mező most a saját CDF-jén keresztül
   egyenletesítődik.
3. Lineáris fényerőtérben a paletta sRGB-ben maradt, így a legközelebbi-szín
   keresés értelmetlen volt — a Game Boy és a Riso paletta egyszínű foltra
   omlott. A paletta most a pixelekkel azonos térbe konvertálódik.
4. A súlyozott RGB metrika `(2 + rmean)` együtthatója gamut-on kívüli értékeknél
   nullára fordul, és a rangsor összeomlik — a hibaterjesztés rendszeresen kilóg
   a gamutból. A lekérdezés most clampelődik.

Mind a négyre van regressziós teszt.
