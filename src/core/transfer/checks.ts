import type { TransferRender } from './engine';
import { removeSmallInk, unsupportedInk } from './components';
import { erodeDisk, openDisk } from './morph';
import { FILM_WIDTHS, type Placement, type ShirtSize } from './presets';
import { coverageNeed, inkDirection, toPerceptual } from './engine';
import { MILKY_DISTANCE, MILKY_LIMIT } from './tune';
import { srgbToLinear } from '../color/space';
import { effectiveMinDotMm, mmToPx, pxToMm, type TransferSettings } from './types';

/**
 * Preflight: the questions a DTF print shop asks before running a file.
 * Every threshold is a published production figure (see README.md).
 */

/** Thinnest positive line that reliably survives DTF pressing and washing. */
export const MIN_LINE_MM = 0.45;

export type CheckLevel = 'ok' | 'info' | 'warn' | 'error';

export interface TransferCheck {
  readonly id: string;
  readonly level: CheckLevel;
  readonly title: string;
  readonly detail: string;
}

export interface TransferAnalysis {
  checks: TransferCheck[];
  /** White underbase after the RIP's choke (1 = white). */
  white: Uint8Array;
  /** Ink with no white at all underneath — it disappears on dark fabric. */
  unsupported: Uint8Array;
  /** Solid features narrower than MIN_LINE_MM. */
  thin: Uint8Array;
  /** Ink so close to the shirt colour that it prints milky over white. */
  milky: Uint8Array;
  stats: {
    milkyShare: number;
    inkFraction: number;
    semiTransparent: number;
    unsupportedCount: number;
    unsupportedAreaMm2: number;
    thinCount: number;
    thinAreaMm2: number;
  };
}

export interface AnalysisContext {
  shirt?: ShirtSize;
  placement?: Placement;
}

function fmt(v: number, digits = 1): string {
  return v.toFixed(digits).replace('.', ',');
}

export function analyzeTransfer(
  r: TransferRender,
  s: TransferSettings,
  ctx: AnalysisContext = {},
): TransferAnalysis {
  const w = r.width;
  const h = r.height;
  const n = w * h;
  const checks: TransferCheck[] = [];
  const pxArea = (25.4 / r.dpi) ** 2;

  const ink = new Uint8Array(n);
  let inkCount = 0;
  let semi = 0;
  for (let p = 0; p < n; p++) {
    const a = r.rgba[p * 4 + 3];
    if (a !== 0 && a !== 255) semi++;
    if (a !== 0) {
      ink[p] = 1;
      inkCount++;
    }
  }

  // ---- Resolution of the source at print size -----------------------------
  // Two standards apply. DTF shops ask for 300 DPI at final size, which is
  // what solid edges and text need. Screened tones only need the prepress
  // quality factor of twice the screen ruling — the dots cannot show more.
  const srcDpi = r.sourceDpi;
  const effDotForRes = effectiveMinDotMm(s);
  const halftoneNeed = s.screen.kind === 'am' ? 2 * s.screen.lpi : (2 * 25.4) / effDotForRes;
  const maxAt300 = (r.widthMm * srcDpi) / 300;
  if (srcDpi >= 300) {
    checks.push({
      id: 'resolution',
      level: 'ok',
      title: `Felbontás: ${Math.round(srcDpi)} DPI a nyomat méretén`,
      detail: 'Eléri a DTF szabvány 300 DPI-t.',
    });
  } else if (srcDpi >= 200) {
    checks.push({
      id: 'resolution',
      level: 'info',
      title: `Felbontás: ${Math.round(srcDpi)} DPI`,
      detail: `300 DPI alatt van, de éles marad. 300 DPI-n legfeljebb ${Math.round(maxAt300)} mm széles lehetne.`,
    });
  } else if (srcDpi >= halftoneNeed) {
    checks.push({
      id: 'resolution',
      level: 'warn',
      title: `Felbontás: ${Math.round(srcDpi)} DPI — a tömör élek lágyabbak lesznek`,
      detail: `A pontozott részekhez elég (legalább ${Math.round(halftoneNeed)} DPI, a raszter kétszerese), de a szöveg és a tömör élek simítva nagyítódnak. Élesebbhez ${Math.round(maxAt300)} mm-es szélesség vagy nagyobb felbontású kép kell.`,
    });
  } else {
    checks.push({
      id: 'resolution',
      level: 'error',
      title: `Felbontás: ${Math.round(srcDpi)} DPI — pixeles lesz`,
      detail: `Még a pontozott részekhez is kevés (legalább ${Math.round(halftoneNeed)} DPI kellene). 300 DPI-n legfeljebb ${Math.round(maxAt300)} mm széles nyomat készíthető belőle.`,
    });
  }

  // ---- No semi-transparent pixels ------------------------------------------
  checks.push(
    semi === 0
      ? {
          id: 'alpha',
          level: 'ok',
          title: 'Nincs félig átlátszó pixel',
          detail: 'Minden pixel teljesen fedett vagy teljesen átlátszó — a RIP nem tesz alá fátyolos fehéret.',
        }
      : {
          id: 'alpha',
          level: 'error',
          title: `${semi} félig átlátszó pixel`,
          detail: 'Ezek alá részleges fehér kerül, ami ködös foltként nyomódik.',
        },
  );

  // ---- Screen ruling --------------------------------------------------------
  const lpi = s.screen.lpi;
  if (s.screen.kind === 'am') {
    if (lpi > 55) {
      checks.push({
        id: 'lpi',
        level: 'error',
        title: `${lpi} LPI — betömődik`,
        detail: '55 LPI fölött a DTF pontok összefolynak. 30–35 LPI a biztonságos kiindulás.',
      });
    } else if (lpi > 45) {
      checks.push({
        id: 'lpi',
        level: 'warn',
        title: `${lpi} LPI — csak jól kalibrált gépen`,
        detail: 'A 35–45 LPI jól beállított gépen még működik; próbanyomat nélkül maradj 30–35-nél.',
      });
    } else if (lpi < 25) {
      checks.push({
        id: 'lpi',
        level: 'info',
        title: `${lpi} LPI — durva, jól látható pontok`,
        detail: 'Stílusnak rendben van, de a tónusátmenetek pöttyösen látszanak.',
      });
    } else {
      checks.push({
        id: 'lpi',
        level: 'ok',
        title: `${lpi} LPI`,
        detail: 'A DTF biztonságos 25–45 LPI sávjában van.',
      });
    }
  }

  // ---- Minimum dot, and what the choke does to it --------------------------
  const effDot = effectiveMinDotMm(s);
  if (s.screen.minDotMm < 0.4) {
    checks.push({
      id: 'min-dot',
      level: 'warn',
      title: `${fmt(s.screen.minDotMm, 2)} mm-es legkisebb pont`,
      detail: '0,40 mm alatt a pontok nem kapnak elég ragasztóport, mosásnál leválhatnak.',
    });
  }
  if (effDot > s.screen.minDotMm + 1e-6) {
    checks.push({
      id: 'choke-dot',
      level: 'info',
      title: `A legkisebb pont ${fmt(effDot, 2)} mm-re nőtt`,
      detail: `A ${fmt(s.chokeMm, 2)} mm-es choke mindkét oldalról eszi a fehéret; ennél kisebb pont alól eltűnne.`,
    });
  }
  const cellMm = 25.4 / Math.max(1, lpi);
  if (s.screen.kind === 'am' && (Math.PI / 4) * (effDot / cellMm) ** 2 > 0.5) {
    checks.push({
      id: 'ruling',
      level: 'warn',
      title: 'A raszter túl sűrű a legkisebb ponthoz',
      detail: `${lpi} LPI-n egy cella ${fmt(cellMm, 2)} mm, ebbe a ${fmt(effDot, 2)} mm-es pont már nem fér el rendesen. Csökkentsd az LPI-t.`,
    });
  }

  // ---- White underbase after the choke --------------------------------------
  const chokePx = mmToPx(s.chokeMm, r.dpi);
  const white = erodeDisk(ink, w, h, chokePx);
  const unsupported = unsupportedInk(ink, white, w, h);
  const unsupportedAreaMm2 = unsupported.area * pxArea;
  checks.push(
    unsupported.count === 0
      ? {
          id: 'white',
          level: 'ok',
          title: 'Minden pont alatt marad fehér',
          detail: `${fmt(s.chokeMm, 2)} mm-es choke mellett is.`,
        }
      : {
          id: 'white',
          level: 'warn',
          title: `${unsupported.count} elem alól eltűnik a fehér`,
          detail: `Összesen ${fmt(unsupportedAreaMm2, 2)} mm². A choke teljesen elviszi alóluk az aláfestést, sötét pólón nem látszanak. Kisebb choke-ot kérj a RIP-ben, vagy növeld a legkisebb pontot.`,
        },
  );

  // ---- Thin solid features -------------------------------------------------
  // A hairline is solid art that is thin in the *final ink*. Grain can make
  // the boundary of a solid area ragged, but where dots continue beyond that
  // boundary the ink is not thin at all — so both masks must agree. Only a
  // thin piece at least 2 mm long counts; shorter remnants are corners.
  const solidInk = new Uint8Array(n);
  for (let p = 0; p < n; p++) solidInk[p] = r.solid[p] === 1 && ink[p] === 1 ? 1 : 0;
  const minLinePx = mmToPx(MIN_LINE_MM, r.dpi);
  const radius = Math.max(0, (minLinePx - 1) / 2);
  const openedSolid = openDisk(solidInk, w, h, radius);
  const openedInk = openDisk(ink, w, h, radius);
  const thin = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    thin[p] = solidInk[p] === 1 && openedSolid[p] === 0 && openedInk[p] === 0 ? 1 : 0;
  }
  removeSmallInk(thin, w, h, minLinePx * mmToPx(2, r.dpi));
  let thinPx = 0;
  for (let p = 0; p < n; p++) thinPx += thin[p];
  const thinCount = countComponents(thin, w, h);
  checks.push(
    thinCount === 0
      ? {
          id: 'thin',
          level: 'ok',
          title: `Nincs ${fmt(MIN_LINE_MM, 2)} mm-nél vékonyabb tömör vonal`,
          detail: 'A szöveg és a körvonalak elég vastagok a tartós nyomathoz.',
        }
      : {
          id: 'thin',
          level: 'warn',
          title: `${thinCount} helyen túl vékony tömör elem`,
          detail: `${fmt(thinPx * pxArea, 2)} mm² vékonyabb ${fmt(MIN_LINE_MM, 2)} mm-nél — mosásnál leválhat. A „Problémák" nézet mutatja, hol.`,
        },
  );

  // ---- Printing garment-coloured areas -------------------------------------
  if (!s.knockout.enabled) {
    const g = s.garment;
    const gl = 0.299 * g.r + 0.587 * g.g + 0.114 * g.b;
    let near = 0;
    for (let p = 0; p < n; p++) {
      if (ink[p] === 0) continue;
      const dr = r.rgba[p * 4] / 255 - g.r;
      const dg = r.rgba[p * 4 + 1] / 255 - g.g;
      const db = r.rgba[p * 4 + 2] / 255 - g.b;
      if (Math.sqrt(dr * dr + dg * dg + db * db) < 0.12) near++;
    }
    if (inkCount > 0 && near / inkCount > 0.02) {
      checks.push({
        id: 'knockout',
        level: gl < 0.3 ? 'warn' : 'info',
        title: 'A póló színével egyező részeket is nyomtatod',
        detail: `A nyomott felület ${Math.round((near / inkCount) * 100)}%-a. Ezek fehér alapra kerülnek és foltként látszanak — kapcsold be a kiütést.`,
      });
    }
  }

  // ---- Milky print: ink the shirt should have supplied ----------------------
  // Everything printed gets white underneath. Ink that is nearly the shirt's
  // own colour therefore comes out as a chalky, greyish patch instead of the
  // deep tone it was meant to be.
  const T = [srgbToLinear(s.garment.r), srgbToLinear(s.garment.g), srgbToLinear(s.garment.b)];
  const dir = inkDirection(T);
  const lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) lin[i] = srgbToLinear(i / 255);
  const milky = new Uint8Array(n);
  let milkyCount = 0;
  for (let p = 0; p < n; p++) {
    if (ink[p] === 0) continue;
    const need = coverageNeed(lin[r.rgba[p * 4]], lin[r.rgba[p * 4 + 1]], lin[r.rgba[p * 4 + 2]], T, dir);
    if (toPerceptual(need) < MILKY_DISTANCE) {
      milky[p] = 1;
      milkyCount++;
    }
  }
  const milkyShare = inkCount > 0 ? milkyCount / inkCount : 0;
  checks.push(
    milkyShare <= MILKY_LIMIT
      ? {
          id: 'milky',
          level: 'ok',
          title: 'Nem lesz tejes',
          detail: `A nyomott felület ${Math.round(milkyShare * 100)}%-a pólóhoz közeli sötét festék — a sötét tónusokat a póló adja.`,
        }
      : {
          id: 'milky',
          level: 'warn',
          title: `Tejes kockázat: a nyomott felület ${Math.round(milkyShare * 100)}%-a`,
          detail: 'Pólóhoz közeli sötét festék kerül fehér alapra, ami szürkés, fakó foltként jön ki. Emeld a tömör határt, vagy futtasd az automatikus beállítást.',
        },
  );

  // ---- White peeking out at the edges --------------------------------------
  // The choke keeps the underbase behind the colour edge. With too little of
  // it, white shows as a halo around every edge — on a halftone, around every
  // single dot, which is exactly what makes a print look washed out.
  const chokePx300 = mmToPx(s.chokeMm, 300);
  if (s.chokeMm < 0.08) {
    checks.push({
      id: 'halo',
      level: 'warn',
      title: 'A fehér alap kilátszhat a széleken',
      detail: `${fmt(s.chokeMm, 2)} mm (${fmt(chokePx300, 1)} px @ 300 DPI) choke-nál a fehér perem látszik a színek és a pontok körül. 0,17–0,25 mm (2–3 px) ajánlott.`,
    });
  } else if (s.chokeMm < 0.16) {
    checks.push({
      id: 'halo',
      level: 'info',
      title: 'Kis choke — apró mintához jó',
      detail: `${fmt(s.chokeMm, 2)} mm (${fmt(chokePx300, 1)} px). Nagy tömör felületnél a csúszás miatt fehér perem látszhat; ott 2–3 px a biztos.`,
    });
  } else {
    checks.push({
      id: 'halo',
      level: 'ok',
      title: 'A fehér nem villan ki a széleken',
      detail: `A ${fmt(s.chokeMm, 2)} mm-es choke a színek széle mögött tartja az alapot.`,
    });
  }

  // ---- Placement size ---------------------------------------------------
  const pl = ctx.placement;
  if (pl) {
    const inch = r.widthMm / 25.4;
    if (r.widthMm < pl.minMm - 0.5 || r.widthMm > pl.maxMm + 0.5) {
      checks.push({
        id: 'placement',
        level: 'info',
        title: `${fmt(inch, 1)}" széles — szokatlan a(z) „${pl.name}" helyre`,
        detail: pl.note,
      });
    } else {
      checks.push({ id: 'placement', level: 'ok', title: `Méret: ${fmt(inch, 1)}" (${Math.round(r.widthMm)} mm)`, detail: pl.note });
    }
    if (pl.id === 'full-front' && ctx.shirt && (ctx.shirt.id === 'S' || ctx.shirt.id === 'M') && inch > 10.05) {
      checks.push({
        id: 'shirt-size',
        level: 'info',
        title: `${ctx.shirt.id} pólóra nagy`,
        detail: 'S–M méreten a teljes elöl nyomat szokásosan 9–10" széles.',
      });
    }
  }

  // ---- Film width ------------------------------------------------------------
  const fits = FILM_WIDTHS.filter((f) => r.widthMm <= f.mm);
  checks.push({
    id: 'film',
    level: fits.length > 0 ? 'info' : 'warn',
    title:
      fits.length > 0
        ? `Ráfér: ${fits.map((f) => f.name).join(', ')}`
        : 'Egyik szabványos filmszélességre sem fér rá',
    detail: `${Math.round(r.widthMm)} × ${Math.round(r.heightMm)} mm.`,
  });

  // ---- Mirror ----------------------------------------------------------------
  checks.push(
    s.mirror
      ? {
          id: 'mirror',
          level: 'warn',
          title: 'A fájl tükrözve lesz mentve',
          detail: 'Csak akkor, ha a saját RIP-ed nem tükröz. DTF szolgáltatónak ne küldj tükrözött fájlt — ők tükröznek.',
        }
      : {
          id: 'mirror',
          level: 'ok',
          title: 'Nem tükrözött',
          detail: 'DTF szolgáltatónak így kell küldeni; a tükrözést a RIP végzi.',
        },
  );

  // ---- Hard photo edge --------------------------------------------------------
  if (s.edgeFade.shape === 'none' && inkCount > 0) {
    let edges = 0;
    const touches = (idx: (i: number) => number, len: number): boolean => {
      let c = 0;
      for (let i = 0; i < len; i++) if (ink[idx(i)] === 1) c++;
      return c / len > 0.6;
    };
    if (touches((i) => i, w)) edges++;
    if (touches((i) => (h - 1) * w + i, w)) edges++;
    if (touches((i) => i * w, h)) edges++;
    if (touches((i) => i * w + w - 1, h)) edges++;
    if (edges >= 3) {
      checks.push({
        id: 'edge',
        level: 'info',
        title: 'Egyenes, vágott képszél',
        detail: 'Fotónál a „Szél elhalványítása" pontokba oldja a széleket — nem lesz matrica-hatású folt.',
      });
    }
  }

  return {
    checks,
    white,
    unsupported: unsupported.mask,
    thin,
    milky,
    stats: {
      milkyShare,
      inkFraction: n > 0 ? inkCount / n : 0,
      semiTransparent: semi,
      unsupportedCount: unsupported.count,
      unsupportedAreaMm2,
      thinCount,
      thinAreaMm2: thinPx * pxArea,
    },
  };
}

function countComponents(mask: Uint8Array, w: number, h: number): number {
  // Reuse the speck remover as a counter: removing everything below infinity
  // would destroy the mask, so count on a copy.
  const copy = mask.slice();
  return removeSmallInk(copy, w, h, Number.POSITIVE_INFINITY);
}

export { pxToMm };
