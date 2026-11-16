// Board facts worked out by the rules, not by a language model: what a move actually does, where every piece
// stands, and what is attacked. The coach is given these, and its prose is checked against them afterwards.
import { Chess } from "chess.js";

const NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const SIDE = { w: "White", b: "Black" };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const ORDER = ["k", "q", "r", "b", "n", "p"];

// A chess.js verbose move -> "knight from f6 takes the pawn on e4".
function wordsOf(m) {
  const tail = (m.promotion ? `, promoting to a ${NAME[m.promotion]}` : "") + (m.san.endsWith("#") ? ", checkmate" : m.san.endsWith("+") ? " with check" : "");
  if (m.flags.includes("k")) return "castling kingside" + tail;
  if (m.flags.includes("q")) return "castling queenside" + tail;
  if (m.flags.includes("e")) return `pawn from ${m.from} takes the pawn en passant, landing on ${m.to}${tail}`;
  return `${NAME[m.piece]} from ${m.from} ${m.captured ? `takes the ${NAME[m.captured]} on ${m.to}` : `to ${m.to}`}${tail}`;
}

// One move in a position, in words. Null if it isn't legal there.
export function moveWords(fen, san) {
  try {
    return wordsOf(new Chess(fen).move(san));
  } catch {
    return null;
  }
}

// A line of moves in words, each with the side that plays it, plus the positions it passes through.
export function lineWords(fen, sans, max = 4) {
  const chess = new Chess(fen);
  const words = [];
  const fens = [];
  for (const san of sans.slice(0, max)) {
    try {
      const m = chess.move(san);
      words.push(`${SIDE[m.color]}'s ${wordsOf(m)}`);
      fens.push(chess.fen());
    } catch {
      break;
    }
  }
  return { words, fens };
}

function piecesOf(chess) {
  return chess.board().flat().filter(Boolean);
}

// "White: king e1; queen d1; rook a1, h1; ... | Black: ..."
export function pieceList(fen) {
  const all = piecesOf(new Chess(fen));
  return ["w", "b"]
    .map((c) => {
      const groups = ORDER.map((t) => {
        const sqs = all.filter((p) => p.color === c && p.type === t).map((p) => p.square).sort();
        return sqs.length ? `${NAME[t]} ${sqs.join(", ")}` : null;
      }).filter(Boolean);
      return `${SIDE[c]}: ${groups.join("; ")}`;
    })
    .join(" | ");
}

export function material(fen) {
  const sum = { w: 0, b: 0 };
  for (const p of piecesOf(new Chess(fen))) sum[p.color] += VAL[p.type];
  return sum;
}

// Every piece that an enemy piece attacks, with who attacks it and who defends it.
export function attacked(fen) {
  const chess = new Chess(fen);
  const at = (sq) => `${NAME[chess.get(sq).type]} ${sq}`;
  const out = [];
  for (const p of piecesOf(chess)) {
    if (p.type === "k") continue;
    const enemy = p.color === "w" ? "b" : "w";
    const attackers = chess.attackers(p.square, enemy);
    if (!attackers.length) continue;
    const defenders = chess.attackers(p.square, p.color);
    out.push(`${SIDE[p.color]} ${at(p.square)} is attacked by ${attackers.map(at).join(", ")} and ${defenders.length ? `defended by ${defenders.map(at).join(", ")}` : "NOT defended"}`);
  }
  return out;
}

// ---------- Checking prose against the board ----------

const CLAIM = /\b(?:(white's|black's|your|their|his|her|the opponent's|opponent's)\s+(?:(?:own|other|remaining|last|only|active|loose|strong|weak|good|bad|light-squared|dark-squared|extra|passed|isolated|advanced|central|well-placed|undefended|unprotected|hanging|attacked|pinned)\s+){0,2})?(pawn|knight|bishop|rook|queen|king)s?\s+(?:sitting\s+|standing\s+|placed\s+)?on\s+([a-h][1-8])\b/gi;
const TYPE = Object.fromEntries(Object.entries(NAME).map(([k, v]) => [v, k]));

// Claims like "White's knight on e4" that are true in none of the given positions.
// Returns [{ claim, square, actual }] where actual describes what stands there in the first position given.
export function wrongClaims(text, fens, studentColor) {
  if (!text || !fens.length) return [];
  const boards = fens.map((f) => new Chess(f));
  const bad = [];
  for (const m of text.matchAll(CLAIM)) {
    const owner = m[1]?.toLowerCase();
    const type = TYPE[m[2].toLowerCase()];
    const sq = m[3].toLowerCase();
    const other = studentColor === "w" ? "b" : "w";
    const color = !owner ? null : owner === "white's" ? "w" : owner === "black's" ? "b" : owner === "your" ? studentColor : other;
    const ok = boards.some((b) => {
      const p = b.get(sq);
      return p && p.type === type && (!color || p.color === color);
    });
    if (ok) continue;
    const here = boards[0].get(sq);
    bad.push({ claim: m[0], square: sq, actual: here ? `${SIDE[here.color]}'s ${NAME[here.type]}` : "nothing" });
  }
  return bad;
}
