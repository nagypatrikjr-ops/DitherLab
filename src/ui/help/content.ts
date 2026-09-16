import type { Language } from '../../i18n';

/** Long-form help, written separately per language rather than assembled from fragments. */

export interface HelpStep {
  readonly title: string;
  readonly text: string;
}

export interface HelpContent {
  readonly start: { intro: string; steps: HelpStep[]; tipsTitle: string; tips: string[] };
  readonly dtf: {
    intro: string;
    steps: HelpStep[];
    milkyTitle: string;
    milky: string;
    shopTitle: string;
    shop: string[];
    pressTitle: string;
    press: string[];
  };
  readonly glossary: HelpStep[];
  readonly about: string[];
}

export function helpContent(lang: Language, mod: (key: string) => string, version: string): HelpContent {
  return lang === 'hu' ? hu(mod, version) : en(mod, version);
}

function en(mod: (key: string) => string, version: string): HelpContent {
  return {
    start: {
      intro: 'DitherLab turns an image into dithered art or into a print-ready T-shirt file. It works offline — nothing is uploaded.',
      steps: [
        { title: 'Open an image', text: `Drag it into the window, click Open, or paste it with ${mod('V')}. Photos, posters and logos all work.` },
        { title: 'Pick a look', text: 'Try a Quick start on the left. Each one adds a few layers on the right, which you can change, reorder or switch off.' },
        { title: 'Compare', text: 'Hold Space (or the Before button) to see the original, or turn on Compare for a split view with a draggable line.' },
        { title: 'Export', text: 'Save PNG, JPG, WEBP or TIFF on the right, or SVG / PDF vectors for cutting plotters and screen printing.' },
        { title: 'Print it on a shirt', text: 'Click “T-shirt print (DTF) →”. The studio prepares a print-ready heat-transfer file — see the T-shirt printing guide.' },
      ],
      tipsTitle: 'Good to know',
      tips: [
        `Everything can be undone with ${mod('Z')}.`,
        'Scroll or pinch to zoom, drag to move the image, press F to fit it back into the window.',
        'Sliders: drag for big steps, hold Shift for fine steps, or type an exact number into the box.',
        'Large images are previewed at a lower resolution to stay fast. Exports always use the full resolution.',
        `Settings (${mod(',')}) has the interface language, the interface size and where files are saved.`,
      ],
    },
    dtf: {
      intro:
        'DTF (direct-to-film) is a heat-transfer print: the design is printed onto film with a white layer behind it, dusted with adhesive powder and pressed onto the shirt. DitherLab prepares the file so it looks right on the shirt color you choose — especially on black.',
      steps: [
        { title: 'Start with a good image', text: 'The bigger the better: about 3300 px wide for a 28 cm (11") print. The studio shows the resulting DPI under Source.' },
        { title: 'Open the studio', text: 'Click “T-shirt print (DTF) →”. Choose whether to print the original image or your dithered version.' },
        {
          title: 'Choose the shirt',
          text: 'Pick the shirt color, size and fabric. On a black shirt the black parts of the design are not printed — the shirt shows through instead. This is called black knockout.',
        },
        { title: 'Choose placement and size', text: 'Full front, left chest, full back… The width follows common print-shop guidelines; change it if you like.' },
        {
          title: 'Let the automatic settings work',
          text: 'For every image the program tunes the knockout so dark tones come from the shirt, not from grey ink printed on white. Pick “More solid”, “Balanced” or “More open” to taste.',
        },
        {
          title: 'Name the inks, if the design has only a few',
          text: 'Under “Ink colours” you can say which colours may be printed. The panel reads the colours out of the print and shows how much of it each one covers; click the ones you want. Everything else is either left unprinted or takes one of your colours — which is how you get rid of stray specks a scan or a JPEG left in a two- or three-colour design. It never changes the dots: the shading stays exactly as it was, only the colour a dot prints with can change.',
        },
        {
          title: 'Check',
          text: 'The banner at the top and the Check list tell you if anything needs attention: resolution, lines that are too thin, dots that would lose their white, milky areas. The Problems view marks them in color.',
        },
        {
          title: 'Save',
          text: '“Print-ready PNG” is the file for the print shop. “Print-shop package” puts that PNG, a mockup and a job sheet with the size and pressing instructions into one ZIP.',
        },
      ],
      milkyTitle: 'Why prints look milky — and how DitherLab avoids it',
      milky:
        'Everything that gets printed has white ink underneath. A dark grey or dark red printed over white comes out lighter and chalky: “milky”. On a black shirt it is better to let the shirt be the dark color. DitherLab turns dark tones into small dots with the shirt showing between them, so the eye sees the right dark tone and the print stays soft and breathable.',
      shopTitle: 'What to tell the print shop',
      shop: [
        'Send the PNG as it is: transparent background, 300 DPI, not mirrored — the shop mirrors it.',
        'Give the print width in cm or inches. It is also in the file name.',
        'Tell them the white choke the file was prepared for (it is on the job sheet) and ask them not to use a larger one.',
        'If they offer a test print, take it. It is the only real proof of how the colors come out.',
      ],
      pressTitle: 'Pressing it yourself',
      press: [
        'Use the temperature, time and pressure the studio shows for your fabric. If the film maker’s data sheet says otherwise, the data sheet wins.',
        'Pre-press the shirt for a few seconds to remove moisture and wrinkles.',
        'Peel hot or cold as the film requires, then press once more with parchment paper for durability.',
        'Wait 24 hours before the first wash. Wash inside out, cold, and skip the tumble dryer.',
      ],
    },
    glossary: [
      { title: 'DTF (direct-to-film)', text: 'A heat-transfer print: ink and a white layer are printed on film, powdered with adhesive and pressed onto fabric.' },
      { title: 'White underbase', text: 'The white ink printed under the colors so they stay bright on dark fabric.' },
      {
        title: 'Black knockout',
        text: 'Leaving out the parts of the design that match the shirt color, so the shirt itself shows there. The print gets softer and lighter, and dark areas cannot turn milky.',
      },
      { title: 'Milky print', text: 'Dark ink printed over white underbase looks chalky and grey. DitherLab measures this and keeps it below 5% of the print.' },
      { title: 'Halftone (dots)', text: 'Building tones out of small dots of one ink. From a normal distance the eye blends them into a smooth tone.' },
      { title: 'LPI (lines per inch)', text: 'How dense the dot grid is. DTF usually works at 25–45 LPI; much higher and the dots get too small to hold.' },
      { title: 'DPI (dots per inch)', text: 'Pixels per inch at the printed size. DTF shops ask for 300 DPI.' },
      { title: 'Choke', text: 'Shrinking the white underbase slightly so it hides behind the colors and never peeks out at the edges.' },
      { title: 'RIP', text: 'The print shop’s printing software. It creates the white layer and mirrors the file.' },
      { title: 'Mirroring', text: 'Flipping the file left to right for printing on film. The shop or RIP does it — do not send mirrored files.' },
      { title: 'Gang sheet', text: 'A long film with many designs on it, printed and cut together. Common widths are 22" and 60 cm.' },
      { title: 'Hot / cold peel', text: 'Whether the carrier film comes off right after pressing or after it cools. It depends on the film.' },
      { title: 'AM / FM screen', text: 'AM: a regular grid of dots that change size. FM: dots of the same size whose spacing changes.' },
      { title: 'Dot gain', text: 'Dots print slightly larger than in the file because ink spreads.' },
      { title: 'Film positive', text: 'For screen printing: a black-on-clear print of one ink, used to expose the screen.' },
      { title: 'Mesh count', text: 'Threads per inch of a screen-printing screen. Finer halftones need a higher mesh.' },
      { title: 'Dithering', text: 'Showing many shades with only a few colors by arranging pixels in patterns.' },
      { title: 'Error diffusion', text: 'A dithering method that passes each pixel’s rounding error on to its neighbors (for example Floyd–Steinberg). Organic, grainy look.' },
      { title: 'Ordered dither', text: 'Dithering with a fixed threshold pattern (for example Bayer). Regular, retro look.' },
      { title: 'Palette', text: 'The set of colors the result is allowed to use.' },
      { title: 'Transparent PNG', text: 'An image with see-through areas. On a transfer, everything transparent stays unprinted.' },
    ],
    about: [
      `DitherLab ${version} — dithering, halftones and print-ready T-shirt files.`,
      'Privacy: everything runs on this computer. Images, settings and the recent-images list are stored only here. The optional Claude review in the T-shirt studio sends a reduced preview to Anthropic, and only after you add your own API key and agree to it.',
      'The print guidance in the T-shirt studio (resolution, dot sizes, pressing) comes from published print-shop and manufacturer figures. Your film and press maker’s instructions always come first.',
      'In the desktop app, exported files go to your Downloads folder unless you choose another folder in Settings.',
    ],
  };
}

function hu(mod: (key: string) => string, version: string): HelpContent {
  return {
    start: {
      intro: 'A DitherLab egy képből dithered grafikát vagy nyomdakész pólófájlt készít. Internet nélkül működik — semmit nem tölt fel.',
      steps: [
        { title: 'Nyiss meg egy képet', text: `Húzd be az ablakba, kattints a Megnyitásra, vagy illeszd be: ${mod('V')}. Fotó, plakát, logó — mind jó.` },
        { title: 'Válassz stílust', text: 'Próbálj ki egy Gyorsindítást balra. Mindegyik néhány réteget tesz jobbra, amit módosíthatsz, átrendezhetsz vagy kikapcsolhatsz.' },
        { title: 'Hasonlítsd össze', text: 'A szóközt (vagy az Előtte gombot) nyomva tartva az eredeti látszik; az Összehasonlítás osztott nézetet ad húzható vonallal.' },
        { title: 'Exportálj', text: 'Jobbra menthetsz PNG-t, JPG-t, WEBP-et vagy TIFF-et, vágóplotterhez és szitához pedig SVG / PDF vektort.' },
        { title: 'Nyomtasd pólóra', text: 'Kattints a „Pólóra (DTF) →” gombra. A stúdió nyomdakész, rávasalós transzfer fájlt készít — lásd a pólónyomtatási útmutatót.' },
      ],
      tipsTitle: 'Jó tudni',
      tips: [
        `Minden visszavonható: ${mod('Z')}.`,
        'Görgetéssel vagy csippentéssel nagyítasz, húzással mozgatod a képet, F-fel visszaigazítod az ablakhoz.',
        'Csúszkák: húzással nagy lépés, Shift-tel finom lépés, a mezőbe pontos szám is írható.',
        'A nagy képek előnézete a gyorsaság miatt kisebb felbontású. Az export mindig teljes felbontással készül.',
        `A Beállításokban (${mod(',')}) van a felület nyelve, mérete és a mentés helye.`,
      ],
    },
    dtf: {
      intro:
        'A DTF (direct-to-film) rávasalós nyomat: a mintát fehér réteggel együtt fóliára nyomtatják, ragasztóporral beszórják, és a pólóra préselik. A DitherLab úgy készíti el a fájlt, hogy a választott pólószínen — főleg feketén — jól nézzen ki.',
      steps: [
        { title: 'Jó képből indulj', text: 'Minél nagyobb, annál jobb: 28 cm-es (11") nyomathoz kb. 3300 px széles kép. A stúdió a Forrás alatt mutatja a kapott DPI-t.' },
        { title: 'Nyisd meg a stúdiót', text: 'Kattints a „Pólóra (DTF) →” gombra. Kiválaszthatod, hogy az eredeti képet vagy a dithered változatot nyomtasd.' },
        {
          title: 'Válaszd ki a pólót',
          text: 'Add meg a póló színét, méretét és anyagát. Fekete pólón a minta fekete részei nem nyomódnak — ott a póló látszik. Ezt hívják fekete kiütésnek.',
        },
        { title: 'Elhelyezés és méret', text: 'Elöl teljes, bal mell, hát… A szélesség a nyomdák szokásos ajánlását követi; nyugodtan módosítsd.' },
        {
          title: 'Hagyd dolgozni az automatikus beállítást',
          text: 'Minden képnél úgy hangolja a kiütést, hogy a sötét tónusokat a póló adja, ne fehér alapra nyomott szürke festék. Ízlés szerint válaszd a „Tömörebb”, „Kiegyensúlyozott” vagy „Légáteresztőbb” irányt.',
        },
        {
          title: 'Add meg a festékszíneket, ha kevés színnel dolgozol',
          text: 'A „Festékszínek” alatt megmondhatod, mely színek kerüljenek nyomtatásra. A panel kiolvassa a nyomat színeit, és megmutatja, melyik mekkora részét fedi; kattints azokra, amelyeket kérsz. A többi vagy nem nyomódik, vagy az egyik választott színedet kapja — így tűnnek el a szkennelés vagy a JPEG hagyta idegen pöttyök egy két-három színű munkából. A pontokhoz nem nyúl: az árnyékolás pontosan ugyanaz marad, csak az változhat, milyen színnel nyomódik egy pont.',
        },
        {
          title: 'Ellenőrizd',
          text: 'A felső sáv és az Ellenőrzés lista jelzi, ha valamire figyelni kell: felbontás, túl vékony vonal, fehér nélkül maradó pont, tejes rész. A Problémák nézet színnel mutatja ezeket.',
        },
        {
          title: 'Mentsd el',
          text: 'A „Nyomdakész PNG” a nyomdának szóló fájl. A „Nyomdai csomag” egy ZIP-be teszi a PNG-t, egy makettet és a munkalapot a mérettel és a préselési adatokkal.',
        },
      ],
      milkyTitle: 'Miért lesz tejes a nyomat — és hogyan kerüli el a DitherLab',
      milky:
        'Minden nyomtatott rész alá fehér festék kerül. A fehérre nyomott sötétszürke vagy sötétvörös világosabb, krétás lesz: „tejes”. Fekete pólón jobb, ha a sötét színt maga a póló adja. A DitherLab a sötét tónusokat apró pontokra bontja, köztük a póló látszik, így a szem a helyes sötét tónust látja, a nyomat pedig puha és légáteresztő marad.',
      shopTitle: 'Mit mondj a nyomdának',
      shop: [
        'Küldd a PNG-t úgy, ahogy van: átlátszó háttér, 300 DPI, nem tükrözve — a nyomda tükröz.',
        'Add meg a nyomat szélességét centiben vagy colban. A fájlnévben is benne van.',
        'Mondd meg, milyen fehér choke-ra készült a fájl (a munkalapon szerepel), és kérd, hogy ennél nagyobbat ne használjanak.',
        'Ha felajánlanak próbanyomatot, kérd. Csak az mutatja meg biztosan, milyenek lesznek a színek.',
      ],
      pressTitle: 'Ha magad préseled',
      press: [
        'Az anyaghoz a stúdióban látható hőfokot, időt és nyomást használd. Ha a fólia adatlapja mást ír, az adatlap az irányadó.',
        'Préseld elő a pólót néhány másodpercig, hogy kimenjen belőle a nedvesség és a gyűrődés.',
        'A fólia szerint meleg vagy hideg állapotban húzd le, aztán sütőpapírral préseld át még egyszer a tartósságért.',
        'Az első mosás előtt várj 24 órát. Kifordítva, hidegen mosd, szárítógép nélkül.',
      ],
    },
    glossary: [
      { title: 'DTF (direct-to-film)', text: 'Rávasalós nyomat: a festéket és egy fehér réteget fóliára nyomtatják, ragasztóporral beszórják és az anyagra préselik.' },
      { title: 'Fehér aláfestés', text: 'A színek alá nyomott fehér festék, hogy sötét anyagon is élénkek maradjanak.' },
      {
        title: 'Fekete kiütés',
        text: 'A minta pólószínű részeit nem nyomtatjuk, ott maga a póló látszik. A nyomat puhább és könnyebb lesz, a sötét részek pedig nem lehetnek tejesek.',
      },
      { title: 'Tejes nyomat', text: 'A fehér alapra nyomott sötét festék krétás, szürkés lesz. A DitherLab ezt méri, és a nyomat 5%-a alatt tartja.' },
      { title: 'Raszter (pontok)', text: 'A tónusokat egyetlen festék apró pontjaiból építjük fel. Normál távolságból a szem egyenletes tónussá olvasztja őket.' },
      { title: 'LPI (vonal / col)', text: 'Milyen sűrű a ponthálózat. DTF-hez általában 25–45 LPI; sokkal sűrűbbnél a pontok túl kicsik lesznek.' },
      { title: 'DPI (pont / col)', text: 'Hány pixel jut egy colra a nyomtatott méreten. A DTF nyomdák 300 DPI-t kérnek.' },
      { title: 'Choke', text: 'A fehér aláfestés kicsit szűkebb a színeknél, így mögöttük marad, és nem villan ki a széleken.' },
      { title: 'RIP', text: 'A nyomda nyomtatószoftvere. Ez készíti el a fehér réteget és tükrözi a fájlt.' },
      { title: 'Tükrözés', text: 'A fájl bal-jobb megfordítása a fóliára nyomtatáshoz. A nyomda vagy a RIP végzi — ne küldj tükrözött fájlt.' },
      { title: 'Gang sheet', text: 'Hosszú fólia sok mintával, amit egyben nyomtatnak és vágnak. Gyakori szélesség: 22" és 60 cm.' },
      { title: 'Meleg / hideg lehúzás', text: 'A hordozófóliát préselés után azonnal vagy kihűlve kell lehúzni. A fóliától függ.' },
      { title: 'AM / FM raszter', text: 'AM: szabályos pontrács, ahol a pontok mérete változik. FM: egyforma pontok, amelyek sűrűsége változik.' },
      { title: 'Pontnövekedés', text: 'A pontok a nyomaton kicsit nagyobbak, mint a fájlban, mert a festék szétterül.' },
      { title: 'Filmpozitív', text: 'Szitanyomáshoz: egy festék fekete-átlátszó nyomata, ezzel világítják meg a szitát.' },
      { title: 'Szitasűrűség', text: 'A szitaszövet szálainak száma colonként. Finomabb raszterhez sűrűbb szita kell.' },
      { title: 'Dithering', text: 'Kevés színnel sok árnyalat mutatása úgy, hogy a pixeleket mintázatba rendezzük.' },
      { title: 'Hibaterjesztés', text: 'Dithering módszer, amely minden pixel kerekítési hibáját a szomszédokra osztja (pl. Floyd–Steinberg). Organikus, szemcsés hatás.' },
      { title: 'Rendezett dither', text: 'Dithering fix küszöbmintával (pl. Bayer). Szabályos, retró hatás.' },
      { title: 'Paletta', text: 'Azok a színek, amelyeket az eredmény használhat.' },
      { title: 'Átlátszó PNG', text: 'Kép átlátszó részekkel. Transzferen minden átlátszó rész nyomtatatlan marad.' },
    ],
    about: [
      `DitherLab ${version} — dithering, raszterezés és nyomdakész pólófájlok.`,
      'Adatvédelem: minden ezen a gépen fut. A képek, a beállítások és a legutóbbi képek listája csak itt tárolódik. A pólóstúdió opcionális Claude ellenőrzése egy kicsinyített előnézetet küld az Anthropicnak, de csak ha megadod a saját API-kulcsodat és hozzájárulsz.',
      'A pólóstúdió nyomtatási adatai (felbontás, pontméret, préselés) publikált nyomdai és gyártói értékekből származnak. A fóliád és a présed gyártójának utasítása mindig elsőbbséget élvez.',
      'Az asztali appban az exportált fájlok a Letöltések mappába kerülnek, hacsak a Beállításokban másik mappát nem választasz.',
    ],
  };
}
