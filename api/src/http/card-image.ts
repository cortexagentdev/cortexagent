import { Resvg } from "@resvg/resvg-js";
import satori, { type SatoriOptions } from "satori";

import type { ResearchCardSnapshot } from "@shared/contracts.ts";
import { formatAbsolute } from "@shared/format.ts";

import { CARD_DISCLAIMER } from "./card-snapshot.ts";

/* The image half of Shareable Research Cards.

   A card leaves Cortex as a PNG because that is the only thing X, Telegram,
   Discord and Slack will render in a link preview; an SVG unfurls as nothing.
   satori lays the card out and produces SVG, resvg rasterises it.

   The renderer is told nothing about signals or lenses. It draws a
   `ResearchCardSnapshot`, so a third subject is a projection in card-snapshot.ts
   and no change at all here. */

// The Open Graph size every consumer crops predictably from.
const WIDTH = 1200;
const HEIGHT = 630;

const INK = "#0D0D12";
const SURFACE = "#16161D";
const LINE = "#2A2A35";
const TEXT = "#F4F4F7";
const TEXT_SOFT = "#B4B6C4";
const TEXT_FAINT = "#7E8093";

/* Satori needs real font binaries; it cannot resolve a webfont, and the terminal
   is set in Inter with JetBrains Mono for figures. The four statics are vendored
   under api/assets/fonts so rendering never depends on the network at request
   time. Read once at module load: a card render should not touch the disk. */
const FONT_DIR = new URL("../../assets/fonts/", import.meta.url);

async function loadFont(file: string): Promise<ArrayBuffer> {
  return await Bun.file(new URL(file, FONT_DIR)).arrayBuffer();
}

const fonts: SatoriOptions["fonts"] = [
  { name: "Inter", weight: 400, style: "normal", data: await loadFont("Inter-Regular.ttf") },
  { name: "Inter", weight: 600, style: "normal", data: await loadFont("Inter-SemiBold.ttf") },
  { name: "Inter", weight: 700, style: "normal", data: await loadFont("Inter-Bold.ttf") },
  {
    name: "JetBrains Mono",
    weight: 500,
    style: "normal",
    data: await loadFont("JetBrainsMono-Medium.ttf"),
  },
];

/* Satori takes a React element tree. The api has no JSX pipeline and adding one
   for a single file would change the build for everything, so the tree is built
   from the plain `{ type, props }` objects React elements are made of and that
   satori reads directly. */
type Node = { type: string; props: Record<string, unknown> };

function el(type: string, style: Record<string, unknown>, children?: unknown): Node {
  return { type, props: { style, ...(children === undefined ? {} : { children }) } };
}

function text(content: string, style: Record<string, unknown>): Node {
  return el("div", { display: "flex", ...style }, content);
}

/** Satori has no `text-overflow`, so anything that could run long is cut here.
 *  Measured in characters against the chosen size, which is close enough at
 *  these widths and never leaves a glyph hanging off the edge. */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function statTile(stat: ResearchCardSnapshot["stats"][number]): Node {
  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      backgroundColor: SURFACE,
      border: `1px solid ${LINE}`,
      borderRadius: 14,
      padding: "14px 18px",
      minWidth: 0,
      flex: 1,
    },
    [
      text(stat.label.toUpperCase(), {
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: 1.1,
        color: TEXT_FAINT,
      }),
      // Tiles share a row at equal width, so a value that wrapped would make its
      // tile taller than its neighbours. It is clamped and held to one line.
      text(clamp(stat.value, 14), {
        marginTop: 6,
        fontSize: 26,
        fontWeight: stat.mono ? 500 : 600,
        fontFamily: stat.mono ? "JetBrains Mono" : "Inter",
        color: TEXT,
        whiteSpace: "nowrap",
      }),
    ],
  );
}

function header(snapshot: ResearchCardSnapshot): Node {
  const chips: Node[] = [
    text("CORTEX", {
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: 3,
      color: TEXT,
    }),
    text(
      snapshot.kind === "signal"
        ? "SIGNAL"
        : snapshot.kind === "asset"
          ? "ASSET QUALITY"
          : "THEME LENS",
      {
        marginLeft: 14,
        fontSize: 15,
        fontWeight: 600,
        letterSpacing: 1.6,
        color: TEXT_FAINT,
      },
    ),
  ];

  if (snapshot.badge) {
    chips.push(
      text(snapshot.badge, {
        marginLeft: "auto",
        fontSize: 15,
        fontWeight: 700,
        letterSpacing: 1.4,
        color: INK,
        backgroundColor: snapshot.accent,
        borderRadius: 999,
        padding: "7px 16px",
      }),
    );
  }

  return el("div", { display: "flex", alignItems: "center", width: "100%" }, chips);
}

/* The bottom strip: what the card is as of, and the line that keeps a card
   pasted into a group chat from reading as a recommendation. Both are part of
   the image rather than the page, because the image is what gets forwarded. */
function footer(snapshot: ResearchCardSnapshot): Node {
  const provenance =
    snapshot.sources.length > 0
      ? `${snapshot.sources.length} source record${snapshot.sources.length === 1 ? "" : "s"} on the card page`
      : "No source records attached";

  return el(
    "div",
    {
      display: "flex",
      flexDirection: "column",
      marginTop: "auto",
      borderTop: `1px solid ${LINE}`,
      paddingTop: 18,
    },
    [
      el("div", { display: "flex", alignItems: "center", width: "100%" }, [
        text(`${snapshot.immutable ? "As of" : "Reading taken"} ${formatAbsolute(snapshot.asOf)}`, {
          fontSize: 17,
          fontWeight: 500,
          fontFamily: "JetBrains Mono",
          color: TEXT_SOFT,
        }),
        text(provenance, {
          marginLeft: "auto",
          fontSize: 16,
          color: TEXT_FAINT,
        }),
      ]),
      text(CARD_DISCLAIMER, {
        marginTop: 10,
        fontSize: 15,
        color: TEXT_FAINT,
        lineHeight: 1.35,
      }),
    ],
  );
}

function card(snapshot: ResearchCardSnapshot): Node {
  const body: Node[] = [
    header(snapshot),
    text(clamp(snapshot.headline, 34), {
      marginTop: 26,
      fontSize: 58,
      fontWeight: 700,
      color: TEXT,
      lineHeight: 1.1,
    }),
    text(clamp(snapshot.summary, 190), {
      marginTop: 14,
      fontSize: 25,
      color: TEXT_SOFT,
      lineHeight: 1.4,
    }),
  ];

  // At most five tiles, in one row. A sixth would force a wrap that pushes the
  // footer off the card, and the tiles are ordered most-cited-first anyway.
  const tiles = snapshot.stats.slice(0, 5);
  if (tiles.length > 0) {
    body.push(
      el("div", { display: "flex", gap: 12, marginTop: 28, width: "100%" }, tiles.map(statTile)),
    );
  }

  if (snapshot.evidenceLine) {
    body.push(
      text(clamp(snapshot.evidenceLine, 120), {
        marginTop: 18,
        fontSize: 19,
        fontFamily: "JetBrains Mono",
        fontWeight: 500,
        color: TEXT_SOFT,
        lineHeight: 1.35,
      }),
    );
  }

  // A card that could not read part of its subject says so on its face. It is
  // the one thing a screenshot must not be able to leave behind.
  //
  // Only the first note is drawn, and whole. Joining them ran past the space and
  // clipped mid-word, and a caveat cut off halfway is worse than a short one:
  // the reader is left knowing something was wrong but not what. The rest are on
  // the card page, which the count points at.
  const [primaryNote, ...furtherNotes] = snapshot.unavailable;
  if (primaryNote) {
    const suffix =
      furtherNotes.length > 0 ? ` (+${furtherNotes.length} more on the card page)` : "";
    body.push(
      text(`${clamp(primaryNote, 150)}${suffix}`, {
        marginTop: 18,
        fontSize: 17,
        color: "#FF9A5C",
        lineHeight: 1.35,
      }),
    );
  }

  body.push(footer(snapshot));

  return el(
    "div",
    {
      display: "flex",
      width: WIDTH,
      height: HEIGHT,
      backgroundColor: INK,
      fontFamily: "Inter",
    },
    [
      // The subject's own colour, carried as a spine down the left edge.
      el("div", { display: "flex", width: 10, height: "100%", backgroundColor: snapshot.accent }),
      el(
        "div",
        {
          display: "flex",
          flexDirection: "column",
          flex: 1,
          padding: "44px 52px 38px 46px",
        },
        body,
      ),
    ],
  );
}

/** The card as a PNG. Throws only if satori or resvg fail, which the route
 *  turns into a placeholder rather than a broken image. */
export async function renderCardPng(snapshot: ResearchCardSnapshot): Promise<Uint8Array> {
  const svg = await satori(card(snapshot) as never, { width: WIDTH, height: HEIGHT, fonts });
  const png = new Resvg(svg, { fitTo: { mode: "width", value: WIDTH } }).render().asPng();
  return new Uint8Array(png);
}

/** What is served when a card cannot be built: still a PNG at the right size, so
 *  a preview shows Cortex saying it has nothing rather than a broken image. */
export async function renderUnavailablePng(message: string): Promise<Uint8Array> {
  const placeholder: ResearchCardSnapshot = {
    kind: "signal",
    id: "unavailable",
    path: "/",
    headline: "Card unavailable",
    summary: message,
    accent: TEXT_FAINT,
    badge: null,
    stats: [],
    evidenceLine: null,
    sources: [],
    asOf: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    immutable: false,
    unavailable: [],
  };
  return await renderCardPng(placeholder);
}
