import { CORE_EN } from './core-en';

/**
 * English for the core's *generated* messages — preflight checks, auto-tune
 * notes, screen-print notes and a few errors. They embed numbers and names, so
 * they are matched by pattern instead of by exact text. The core itself is
 * never changed; if a message is not recognised it is shown as is.
 */

type Rule = readonly [RegExp, (m: RegExpMatchArray) => string];

/** Hungarian decimal comma → English decimal point. */
const n = (s: string | undefined): string => (s ?? '').replace(',', '.');
const name = (s: string | undefined): string => {
  const v = s ?? '';
  return CORE_EN[v] ?? translateDynamicEn(v) ?? v;
};
const names = (s: string | undefined): string => (s ?? '').split(', ').map(name).join(', ');

const NUM = '(\\d+(?:,\\d+)?)';
const PCT = '(\\d+(?:,\\d+)?%)';

function rx(source: string): RegExp {
  return new RegExp(`^${source}$`);
}

const RULES: readonly Rule[] = [
  // ---- DTF preflight: resolution ------------------------------------------
  [rx(`Felbontás: ${NUM} DPI a nyomat méretén`), (m) => `Resolution: ${n(m[1])} DPI at print size`],
  [rx(`Felbontás: ${NUM} DPI — a tömör élek lágyabbak lesznek`), (m) => `Resolution: ${n(m[1])} DPI — solid edges will be softer`],
  [rx(`Felbontás: ${NUM} DPI — pixeles lesz`), (m) => `Resolution: ${n(m[1])} DPI — it will look pixelated`],
  [rx(`Felbontás: ${NUM} DPI`), (m) => `Resolution: ${n(m[1])} DPI`],
  [
    rx(`300 DPI alatt van, de éles marad\\. 300 DPI-n legfeljebb ${NUM} mm széles lehetne\\.`),
    (m) => `Below 300 DPI, but it stays sharp. At 300 DPI it could be at most ${n(m[1])} mm wide.`,
  ],
  [
    rx(
      `A pontozott részekhez elég \\(legalább ${NUM} DPI, a raszter kétszerese\\), de a szöveg és a tömör élek simítva nagyítódnak\\. Élesebbhez ${NUM} mm-es szélesség vagy nagyobb felbontású kép kell\\.`,
    ),
    (m) =>
      `Enough for the dotted areas (at least ${n(m[1])} DPI, twice the screen ruling), but text and solid edges are enlarged smoothly. For crisper edges, print at ${n(m[2])} mm wide or use a higher-resolution image.`,
  ],
  [
    rx(`Még a pontozott részekhez is kevés \\(legalább ${NUM} DPI kellene\\)\\. 300 DPI-n legfeljebb ${NUM} mm széles nyomat készíthető belőle\\.`),
    (m) => `Too low even for the dotted areas (at least ${n(m[1])} DPI needed). At 300 DPI this image supports a print at most ${n(m[2])} mm wide.`,
  ],
  // ---- alpha, screen ruling, dots -----------------------------------------------
  [rx(`${NUM} félig átlátszó pixel`), (m) => `${n(m[1])} semi-transparent pixels`],
  [rx(`${NUM} LPI — betömődik`), (m) => `${n(m[1])} LPI — the dots will fill in`],
  [rx(`${NUM} LPI — csak jól kalibrált gépen`), (m) => `${n(m[1])} LPI — only on a well-calibrated printer`],
  [rx(`${NUM} LPI — durva, jól látható pontok`), (m) => `${n(m[1])} LPI — coarse, clearly visible dots`],
  [rx(`${NUM} LPI`), (m) => `${n(m[1])} LPI`],
  [rx(`${NUM} mm-es legkisebb pont`), (m) => `Smallest dot: ${n(m[1])} mm`],
  [rx(`A legkisebb pont ${NUM} mm-re nőtt`), (m) => `The smallest dot grew to ${n(m[1])} mm`],
  [
    rx(`A ${NUM} mm-es choke mindkét oldalról eszi a fehéret; ennél kisebb pont alól eltűnne\\.`),
    (m) => `The ${n(m[1])} mm choke eats into the white from both sides; under a smaller dot it would disappear.`,
  ],
  [
    rx(`${NUM} LPI-n egy cella ${NUM} mm, ebbe a ${NUM} mm-es pont már nem fér el rendesen\\. Csökkentsd az LPI-t\\.`),
    (m) => `At ${n(m[1])} LPI a cell is ${n(m[2])} mm; a ${n(m[3])} mm dot no longer fits properly. Lower the LPI.`,
  ],
  // ---- white underbase, thin lines ---------------------------------------------
  [rx(`${NUM} mm-es choke mellett is\\.`), (m) => `Even with a ${n(m[1])} mm choke.`],
  [rx(`${NUM} elem alól eltűnik a fehér`), (m) => `${n(m[1])} elements lose their white underneath`],
  [
    rx(
      `Összesen ${NUM} mm²\\. A choke teljesen elviszi alóluk az aláfestést, sötét pólón nem látszanak\\. Kisebb choke-ot kérj a RIP-ben, vagy növeld a legkisebb pontot\\.`,
    ),
    (m) =>
      `${n(m[1])} mm² in total. The choke removes all the underbase beneath them, so they vanish on a dark shirt. Ask for a smaller choke in the RIP, or raise the smallest dot.`,
  ],
  [rx(`Nincs ${NUM} mm-nél vékonyabb tömör vonal`), (m) => `No solid line thinner than ${n(m[1])} mm`],
  [rx(`${NUM} helyen túl vékony tömör elem`), (m) => `${n(m[1])} solid details are too thin`],
  [
    rx(`${NUM} mm² vékonyabb ${NUM} mm-nél — mosásnál leválhat\\. A „Problémák" nézet mutatja, hol\\.`),
    (m) => `${n(m[1])} mm² is thinner than ${n(m[2])} mm — it can peel off in the wash. The “Problems” view shows where.`,
  ],
  // ---- knockout, milky, halo -------------------------------------------------
  [
    rx(`A nyomott felület ${NUM}%-a\\. Ezek fehér alapra kerülnek és foltként látszanak — kapcsold be a kiütést\\.`),
    (m) => `${n(m[1])}% of the printed area. These get white underneath and show up as patches — turn on the knockout.`,
  ],
  [
    rx(`A nyomott felület ${NUM}%-a pólóhoz közeli sötét festék — a sötét tónusokat a póló adja\\.`),
    (m) => `${n(m[1])}% of the printed area is dark ink close to the shirt color — the shirt supplies the dark tones.`,
  ],
  [rx(`Tejes kockázat: a nyomott felület ${NUM}%-a`), (m) => `Milky risk: ${n(m[1])}% of the printed area`],
  [
    rx(`${NUM} mm \\(${NUM} px @ 300 DPI\\) choke-nál a fehér perem látszik a színek és a pontok körül\\. 0,17–0,25 mm \\(2–3 px\\) ajánlott\\.`),
    (m) => `With a ${n(m[1])} mm (${n(m[2])} px @ 300 DPI) choke, a white rim shows around colors and dots. 0.17–0.25 mm (2–3 px) is recommended.`,
  ],
  [
    rx(`${NUM} mm \\(${NUM} px\\)\\. Nagy tömör felületnél a csúszás miatt fehér perem látszhat; ott 2–3 px a biztos\\.`),
    (m) => `${n(m[1])} mm (${n(m[2])} px). On large solid areas a slight shift can show a white rim; 2–3 px is the safe choice there.`,
  ],
  [
    rx(`A ${NUM} mm-es choke a színek széle mögött tartja az alapot\\.`),
    (m) => `The ${n(m[1])} mm choke keeps the underbase behind the color edges.`,
  ],
  // ---- size, placement, film --------------------------------------------------
  [rx(`${NUM}" széles — szokatlan a\\(z\\) „(.+)" helyre`), (m) => `${n(m[1])}" wide — unusual for “${name(m[2])}”`],
  [rx(`Méret: ${NUM}" \\((\\d+) mm\\)`), (m) => `Size: ${n(m[1])}" (${m[2]} mm)`],
  [rx(`(S|M|L|XL|2XL|3XL) pólóra nagy`), (m) => `Large for a size ${m[1]} shirt`],
  [rx(`Ráfér: (.+)`), (m) => `Fits: ${names(m[1])}`],
  [rx(`(\\d+) × (\\d+) mm\\.`), (m) => `${m[1]} × ${m[2]} mm.`],
  // ---- auto-tune notes -----------------------------------------------------------
  [
    rx(`Tejes kockázat: ${PCT} → ${PCT} a nyomott felületből\\. A pólóhoz közeli sötét tónusokat most a póló adja a pontok között, nem sötét festék fehér alapon\\.`),
    (m) =>
      `Milky risk: ${n(m[1])} → ${n(m[2])} of the printed area. Dark tones close to the shirt color now come from the shirt between the dots, not from dark ink on white.`,
  ],
  [
    rx(`Tejes kockázat: ${PCT} — a sötét részeket már eddig is a póló adta\\.`),
    (m) => `Milky risk: ${n(m[1])} — the shirt was already supplying the dark areas.`,
  ],
  [
    rx(`A ${PCT}-os cél ezen a képen nem érhető el teljesen: sok a pólóhoz közeli, de tömörnek szánt sötét rész\\.`),
    (m) => `The ${n(m[1])} target cannot be fully met on this image: it has many dark areas close to the shirt color that are meant to be solid.`,
  ],
  [
    rx(`Tömör határ ${PCT} → ${PCT}: ennél sötétebb tónusok pontokból állnak\\.`),
    (m) => `Solid point ${n(m[1])} → ${n(m[2])}: tones darker than this are made of dots.`,
  ],
  [
    rx(`Tolerancia ${PCT} → ${PCT} — a halvány szemcse nem szórja tele pöttyökkel a pólót\\.`),
    (m) => `Tolerance ${n(m[1])} → ${n(m[2])} — faint grain will not scatter specks all over the shirt.`,
  ],
  [rx(`Tolerancia ${PCT} → ${PCT} — több halvány részlet marad meg\\.`), (m) => `Tolerance ${n(m[1])} → ${n(m[2])} — more faint detail is kept.`],
  [rx(`Pontsúly ${NUM} → ${NUM}\\.`), (m) => `Dot weight ${n(m[1])} → ${n(m[2])}.`],
  [
    rx(`Rasztersűrűség (\\d+) → (\\d+) LPI: ez a legsűrűbb, amin a ${NUM} mm-es legkisebb pont még elfér\\.`),
    (m) => `Screen ruling ${m[1]} → ${m[2]} LPI: the finest ruling where the ${n(m[3])} mm smallest dot still fits.`,
  ],
  [
    rx(`A ${NUM} mm-es choke kevés: a fehér alap kilátszhat a színek szélén\\. 0,17–0,25 mm ajánlott\\.`),
    (m) => `A ${n(m[1])} mm choke is too small: the white underbase may show at the color edges. 0.17–0.25 mm is recommended.`,
  ],
  [
    rx(`A minta ${PCT}-a ritka, szórt pontokból áll — szemcsés hatás lesz\\.`),
    (m) => `${n(m[1])} of the design is sparse, scattered dots — expect a grainy look.`,
  ],
  // ---- screen-print notes -------------------------------------------------------
  [rx(`(\\d+) LPI-hez (\\d+)–(\\d+) szitasűrűség ajánlott\\.`), (m) => `For ${m[1]} LPI, a ${m[2]}–${m[3]} mesh is recommended.`],
  [rx(`(\\d+) LPI textilre sok — 35 és 55 között a biztonságos sáv\\.`), (m) => `${m[1]} LPI is too fine for textiles — 35 to 55 is the safe range.`],
  [rx(`(\\d+)%-os pont nem tartható; 6–8% a reális alsó határ\\.`), (m) => `A ${m[1]}% dot will not hold; 6–8% is the realistic minimum.`],
  [rx(`(\\d+)% fölött a pontok összefolynak\\.`), (m) => `Above ${m[1]}%, dots merge together.`],
  [
    rx(`A film felbontása kevés: egy rasztercella ([\\d.]+) pixel\\. Emeld a DPI-t\\.`),
    (m) => `The film resolution is too low: one halftone cell is ${m[1]} pixels. Raise the DPI.`,
  ],
  [rx(`„(.+)” üres — erre a szitára nem kerül semmi\\.`), (m) => `“${name(m[1])}” is empty — nothing goes on this screen.`],
  [
    rx(`„(.+)” gyakorlatilag teljes felület — biztos, hogy nem fordítva van\\?`),
    (m) => `“${name(m[1])}” covers practically everything — are you sure it is not inverted?`,
  ],
  [rx(`(\\d+) szita kell \\((.+)\\)\\.`), (m) => `${m[1]} screens needed (${names(m[2])}).`],
  [rx(`Szín (\\d+)`), (m) => `Color ${m[1]}`],
  // ---- names and errors with a variable part ----------------------------------
  [rx(`(.+) \\(szerkesztett\\)`), (m) => `${name(m[1])} (edited)`],
  [rx(`Lospec válasz: (\\d+)`), (m) => `Lospec responded with ${m[1]}`],
  [rx(`Ismeretlen réteg kihagyva: (.+)`), (m) => `Unknown layer skipped: ${m[1]}`],
  [rx(`Ismeretlen forrás: (.+)`), (m) => `Unknown source: ${m[1]}`],
  [rx(`Nincs ilyen szita: (\\d+)`), (m) => `No such screen: ${m[1]}`],
  [rx(`A kérést elutasította az API: (.+)`), (m) => `The API rejected the request: ${m[1]}`],
  [rx(`Claude API hiba \\((.+)\\): (.+)`), (m) => `Claude API error (${m[1]}): ${m[2]}`],
];

/** English for a generated Hungarian message, or null when it is not recognised. */
export function translateDynamicEn(hu: string): string | null {
  for (const [re, render] of RULES) {
    const m = hu.match(re);
    if (m) return render(m);
  }
  return null;
}
