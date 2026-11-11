// Opening book built from the Lichess chess-openings tables (data/openings/*.tsv).
// A position is "book" if it appears anywhere along a named opening line.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "data", "openings");
const CACHE = path.join(SRC, "book.json");

export const epd = (fen) => fen.split(" ").slice(0, 4).join(" ");

let book = null;

function build() {
  const named = {}; // epd -> [eco, name] (end of a named line)
  const known = {}; // epd -> 1 (any position along a named line)
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".tsv")).sort()) {
    const rows = fs.readFileSync(path.join(SRC, file), "utf8").split("\n").slice(1);
    for (const row of rows) {
      const [eco, name, pgn] = row.split("\t");
      if (!pgn) continue;
      const chess = new Chess();
      try {
        for (const tok of pgn.trim().split(/\s+/)) {
          if (/^\d+\.+$/.test(tok)) continue;
          chess.move(tok);
          known[epd(chess.fen())] = 1;
        }
      } catch {
        continue;
      }
      named[epd(chess.fen())] = [eco, name];
    }
  }
  return { named, known };
}

export function loadBook() {
  if (book) return book;
  try {
    book = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    book = build();
    if (Object.keys(book.named).length) fs.writeFileSync(CACHE, JSON.stringify(book));
  }
  return book;
}

// fensAfter[i] is the position after ply i+1. Returns the opening and how many plies stayed in book.
export function identifyOpening(fensAfter) {
  const { named, known } = loadBook();
  let opening = null;
  let bookPlies = 0;
  for (let i = 0; i < fensAfter.length; i++) {
    const key = epd(fensAfter[i]);
    if (!known[key]) break;
    bookPlies = i + 1;
    if (named[key]) opening = { eco: named[key][0], name: named[key][1], ply: i + 1 };
  }
  return { opening, bookPlies };
}
