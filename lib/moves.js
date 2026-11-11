// Turn a loose move list (PGN, chess.com copy/paste, or moves read off a screenshot) into verified SAN.
import { Chess } from "chess.js";

const FIGURINES = { "♔": "K", "♕": "Q", "♖": "R", "♗": "B", "♘": "N", "♙": "", "♚": "K", "♛": "Q", "♜": "R", "♝": "B", "♞": "N", "♟": "" };

export function tokenize(text) {
  return text
    .replace(/\[[^\]]*\]/g, " ") // PGN headers
    .replace(/\{[^}]*\}/g, " ") // comments
    .replace(/\([^)]*\)/g, " ") // variations
    .replace(/[♔-♟]/g, (c) => FIGURINES[c] ?? "")
    .replace(/\$\d+/g, " ")
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^\d+\.+/, "")) // "12.Nf3" -> "Nf3"
    .filter(Boolean)
    .filter((t) => !/^\d+\.*$/.test(t)) // bare move numbers
    .filter((t) => !/^(1-0|0-1|1\/2-1\/2|½-½|\*)$/.test(t))
    .filter((t) => !/^\d*:?\d+[:.]\d+s?$/.test(t)) // clock times like 0:05 or 3.2
    .map((t) => t.replace(/0-0-0/g, "O-O-O").replace(/0-0/g, "O-O").replace(/[!?]+$/, ""));
}

// Returns { sans } when every move is legal, otherwise { sans (the legal prefix), error }.
export function parseMoves(text) {
  const tokens = Array.isArray(text) ? tokenize(text.join(" ")) : tokenize(text);
  const chess = new Chess();
  const sans = [];
  for (const tok of tokens) {
    let move = null;
    try {
      move = chess.move(tok, { strict: false });
    } catch {}
    if (!move) {
      const n = Math.floor(sans.length / 2) + 1;
      const side = sans.length % 2 === 0 ? "White" : "Black";
      return {
        sans,
        error: {
          ply: sans.length + 1,
          token: tok,
          message: `Move ${n} for ${side} ("${tok}") isn't legal in that position.`,
          legal: chess.moves(),
        },
      };
    }
    sans.push(move.san);
  }
  if (!sans.length) return { sans, error: { ply: 1, token: "", message: "No moves found.", legal: [] } };
  return { sans };
}

export function formatMoves(sans) {
  const out = [];
  for (let i = 0; i < sans.length; i += 2) out.push(`${i / 2 + 1}. ${sans[i]}${sans[i + 1] ? " " + sans[i + 1] : ""}`);
  return out.join(" ");
}
