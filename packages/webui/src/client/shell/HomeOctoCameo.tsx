import { useEffect, useRef, type ReactElement } from "react";

/*
 * A cameo, not a backdrop.
 *
 * The octopus girl is drawn as a field of flat blocks — 64x96 cells sampled
 * from the character sheet and reduced to five tones, so the figure reads as
 * blocks rather than as a downscaled photograph.
 *
 * She is built one cell at a time and taken apart the same way: the build runs
 * as a top-to-bottom scan with a little jitter, the dissolve runs in scattered
 * order, so she assembles like a print and leaves like dust. Between visits
 * nothing is on the surface and no frame loop is running.
 */

const GRID_W = 64;
const GRID_H = 96;

/** One character per cell: 0 is empty, 1..4 are the tone ramp. */
const GRID = `0000000000000000000000000010100000000000000000000000000000000000
0000000000000000000000000001000012000000000000000000000000000000
0000000000000000000000000022333122201000000000000000000000000000
0000000000000000000000001234232200221100000000000000000000000000
0000000000000000000210223242322110123210000000000000000000000000
0000000000000000001212232322221212113400000000000000000000000000
0000000000000000003222432222212232212330000000000000000000000000
0000000000000000013323421213222212221100000000000000000000000000
0000000000000000314344312232322210222322100000000000000000000000
0000000000000002201434332332121213331321110122000000000000000000
0000000000000001311343333331112124322342210012200000000000000000
0000000000000000133321332324310002122222100002200000000000000000
0000000000000110233233433244411011123321301001200000000000000000
0000000000001100122444343321110011023312100002011100000000000000
0000000000010000324444433331101220133232201121222211100000000000
0000000001121002103323443322100100241322332323332111110000000000
0000000022112002323323434432321012434431233332211222310000000000
0000000122000002332334234431133433333431120121000122120000000000
0000000232100122334443432210013443432343221120000032210000000000
0000000223211212343101132200001333342234232200000022100000000000
0000000133334231232231003321112132223222333210112222100010000000
0000000012233324111444100002222123111223330322221200012332000000
0000000000002322310034411000422134100011332233322011211233100000
0002231100013322100102420000230242010011023222222222000013100000
0022101132334320101002421010331430111121103332322220100023100000
0021000012231102310004431000241401111111112433232112110111000000
0021001233432233213124431011333111222221112333433222221000000000
0000012233333432033242320103233211344433120233343323221000000000
0001322243434331133143211123234333444434420033323332422121000000
0002222333232321231122111132133443233434320123200233331222100000
0021223310024342322121211232234332224233420142300232123221200000
0011223200133423332211122423221100343323320340011322003321110000
0122323001334333444333444332201333424102421242123220002332111000
0123122003333434443444443310000444133001321332112300010333220000
0022113233434343323343322210214442232000443331211011200232222000
0013112333231333331100000001333433342000142332110000111322120000
0132322132220233312110000133423234421010133232211000112232210000
0210012223200011000011002444221224200000022133111100012223100000
1100002331000143431000134343212242000000003212311100112221000000
1200000211231333343201343443222430000000002411221111121000000000
1221102222224321222332324444433320002222101240222122343010111000
0001021121133212111112123444443111211211010133021213341112000000
0000212222333121101011223342421022342220001013302242321110200000
0001222212233333000112212334221112131012222102410310000000000000
0001333332334333433231223344322110123122312011341220000000000000
0002233321122334344311112333220000012212210233343021000000000000
0002323310013344444321112332210000101121233233433101100000000000
0002232300013334344422122223112323331111133224331210010000000000
0000323320002343444443322232223242234121233244422231002000000000
0000032222210233343444321223343320001211233433321122000101000000
0000002222200132434444432134444210101121433332321122112222322000
0000000000000312233434342234341000000112332332221023222333332200
0000000000102112334343333243443110101123423232222233323333332220
0000000002000112223433232333343201000114222333112333233333332211
0000000022111122223333323342333210101133334442213343322123333221
0000000212221222222223332332232310010134234433123411000001332321
0000002111211232201222433332321220101133434443224420000000333231
0000011111222420000123332322210011010123343434223321011000132221
0000012112224200100243433333100110111112334333423232221000322220
0000021012233000132333310112001101111100133323332322110112222200
0000023232332000133332200000011111212000013333334331000022222000
0000022223230000001211000000111111121000002322332222000001000000
0000013122330000000000000001111111221010003320333122000000000000
0000002212230000000000000001111112220012122200332211000000000000
0000002212323000210000000011111122210002322000333211000000000000
0000000222122312210000000011111112110000000001332221000000000000
0000000022222232200000000021112221110000001002322230000000000000
0000000000121221000000000111111211010000012112221200000000000000
0000000000000000000000000111212110100000013222222100000000000000
0000000000000000000000012201111100000000001222220000000000000000
0000000000000000000000124321011010100000000010100000000000000000
0000000000000000000000134442010000000000000000000000000000000000
0000000000000000000111212342011010100000000000000000000000000000
0000000000000000001324221112010001000000000000000000000000000000
0000000000000000000024422222001010000000000000000000000000000000
0000000000000000000213331220010000000000000000000000000000000000
0000000000000000012231334420000010000000000000000000000000000000
0000000000000000021331123400032210000000000000000000000000000000
0000000000000000023221323310044430000000000000000000000000000000
0000000000000000023221222210110000000000000000000000000000000000
0000000000000000003321222111201110000000000000000000000000000000
0000000000000000000201121001220101000000000000000000000000000000
0000000000000000002110121001321011000000000000000000000000000000
0000000000000000002200011003332232000000000000000000000000000000
0000000000000000003220001033432243200000000000000000000000000000
0000000000000000002311011034211123110000000000000000000000000000
0000000000000000000344431013212120030000000000000000000000000000
0000000000000000000024430013101111020000000000000000000000000000
0000000000000000000000000023101121000000000000000000000000000000
0000000000000000000000000013100001000000000000000000000000000000
0000000000000000000000000122100000100000000000000000000000000000
0000000000000000000000000232110000010000000000000000000000000000
0000000000000000000000000043112243310000000000000000000000000000
0000000000000000000000000003321444430000000000000000000000000000
0000000000000000000000000000334444430000000000000000000000000000
0000000000000000000000000000011111000000000000000000000000000000`;

const LIGHT_TONES = [null, "#fdeef4", "#facfde", "#f4a0be", "#e46896"] as const;
const DARK_TONES = [null, "#241a22", "#3a2430", "#552c3f", "#74394f"] as const;

/** Cells materialise at this rate. One block at a time has to stay legible. */
const BUILD_RATE = 620;
/** The dissolve is quicker than the build; leaving should not drag. */
const DISSOLVE_RATE = 900;

const HOLD_SECONDS = 2.4;
const FIRST_VISIT_MS = 12_000;
const VISIT_GAP_MS = 80_000;

const clamp = (value: number, lo = 0, hi = 1): number =>
  value < lo ? lo : value > hi ? hi : value;

function hash(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

interface Cell {
  readonly x: number;
  readonly y: number;
  readonly tone: number;
  /** 0..1, where this cell falls in the top-to-bottom build scan. */
  readonly buildRank: number;
  /** 0..1, where this cell falls in the scattered dissolve. */
  readonly dissolveRank: number;
}

function readCells(): readonly Cell[] {
  const rows = GRID.split("\n");
  const raw: Array<{ x: number; y: number; tone: number }> = [];
  for (let y = 0; y < GRID_H; y += 1) {
    const row = rows[y] ?? "";
    for (let x = 0; x < GRID_W; x += 1) {
      const tone = Number(row[x] ?? "0");
      if (!tone) continue;
      raw.push({ x, y, tone });
    }
  }

  // Build: a scan down the figure, jittered so the edge is ragged rather than
  // a ruler-straight wipe.
  const byScan = raw
    .map((cell, index) => ({ index, key: cell.y * GRID_W + cell.x + hash(cell.x, cell.y) * 420 }))
    .sort((a, b) => a.key - b.key);
  const buildRank = new Array<number>(raw.length);
  byScan.forEach((entry, rank) => {
    buildRank[entry.index] = rank / Math.max(1, raw.length - 1);
  });

  // Dissolve: scattered, so she comes apart instead of unrolling backwards.
  const byScatter = raw
    .map((cell, index) => ({ index, key: hash(cell.x * 7 + 11, cell.y * 13 + 5) }))
    .sort((a, b) => a.key - b.key);
  const dissolveRank = new Array<number>(raw.length);
  byScatter.forEach((entry, rank) => {
    dissolveRank[entry.index] = rank / Math.max(1, raw.length - 1);
  });

  return raw.map((cell, index) => ({
    ...cell,
    buildRank: buildRank[index],
    dissolveRank: dissolveRank[index],
  }));
}

const CELLS = readCells();

const BUILD_SECONDS = CELLS.length / BUILD_RATE;
const DISSOLVE_SECONDS = CELLS.length / DISSOLVE_RATE;
const VISIT_SECONDS = BUILD_SECONDS + HOLD_SECONDS + DISSOLVE_SECONDS;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function usesDarkSurface(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

/** Runs one cameo at a time on a repeating schedule. */
function runCameos(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) return () => {};

  const tones = usesDarkSurface() ? DARK_TONES : LIGHT_TONES;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let frame = 0;
  let startedAt = 0;
  let scheduleTimer = 0;
  let disposed = false;

  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  };

  const clear = (): void => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  };

  const draw = (elapsed: number): void => {
    const widthCss = canvas.width / dpr;
    const heightCss = canvas.height / dpr;
    if (widthCss === 0 || heightCss === 0) return;

    clear();
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cell = Math.min((heightCss * 0.62) / GRID_H, (widthCss * 0.34) / GRID_W);
    const originX = widthCss - GRID_W * cell - widthCss * 0.02;
    const originY = (heightCss - GRID_H * cell) / 2 + heightCss * 0.05;

    const buildProgress = clamp(elapsed / BUILD_SECONDS);
    const dissolveProgress = clamp((elapsed - BUILD_SECONDS - HOLD_SECONDS) / DISSOLVE_SECONDS);

    // a single slow breath while she is whole
    const holdTime = elapsed - BUILD_SECONDS;
    const breath = holdTime > 0 ? Math.sin(holdTime * 1.5) * 0.012 : 0;
    const cx = GRID_W / 2;

    for (const info of CELLS) {
      if (info.buildRank > buildProgress) continue;
      if (info.dissolveRank < dissolveProgress) continue;

      const px = originX + (cx + (info.x - cx) * (1 + breath)) * cell;
      const py = originY + info.y * cell;

      const tone = tones[info.tone as 1 | 2 | 3 | 4];
      if (!tone) continue;

      context.fillStyle = tone;
      // Integer-aligned so a cell is never a half-lit smear.
      context.fillRect(Math.round(px), Math.round(py), Math.ceil(cell), Math.ceil(cell));
    }
  };

  const tick = (now: number): void => {
    if (disposed) return;
    if (startedAt === 0) startedAt = now;
    const elapsed = (now - startedAt) / 1000;
    if (elapsed >= VISIT_SECONDS) {
      clear();
      frame = 0;
      startedAt = 0;
      schedule(VISIT_GAP_MS);
      return;
    }
    draw(elapsed);
    frame = window.requestAnimationFrame(tick);
  };

  function schedule(delayMs: number): void {
    if (disposed) return;
    window.clearTimeout(scheduleTimer);
    scheduleTimer = window.setTimeout(() => {
      if (disposed) return;
      if (document.hidden) {
        schedule(VISIT_GAP_MS);
        return;
      }
      startedAt = 0;
      frame = window.requestAnimationFrame(tick);
    }, delayMs);
  }

  resize();
  schedule(FIRST_VISIT_MS);

  const onResize = (): void => {
    resize();
    if (startedAt !== 0) {
      draw(Math.min((performance.now() - startedAt) / 1000, VISIT_SECONDS));
    }
  };
  window.addEventListener("resize", onResize);

  const onVisibility = (): void => {
    if (!document.hidden || !frame) return;
    // A cameo interrupted by a hidden tab is abandoned, not resumed.
    window.cancelAnimationFrame(frame);
    frame = 0;
    startedAt = 0;
    clear();
    schedule(VISIT_GAP_MS);
  };
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    disposed = true;
    if (frame) window.cancelAnimationFrame(frame);
    window.clearTimeout(scheduleTimer);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibility);
    clear();
  };
}

/**
 * Periodic cameo on the home surface. Decorative only: it announces nothing
 * and takes no pointer events.
 */
export function HomeOctoCameo(): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    // Repeating decorative motion is exactly what this preference asks us not
    // to do, so she does not appear at all.
    if (prefersReducedMotion()) return undefined;
    return runCameos(canvas);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-webui-home-octo-cameo="true"
      className="pointer-events-none absolute inset-0 -z-10 h-full w-full select-none"
    />
  );
}
