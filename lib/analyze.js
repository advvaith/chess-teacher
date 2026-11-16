// Engine analysis of a full game: per-move evals, classifications, accuracy and a rating estimate.
import { Chess } from "chess.js";
import { evaluatePositions } from "./engine.js";
import { moveWords } from "./facts.js";
import { identifyOpening } from "./openings.js";

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Win probability (0-100) for the side the score belongs to. Same curve Lichess uses.
function winPct({ cp, mate }) {
  if (mate != null) return mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp, -1500, 1500))) - 1);
}
const moveAccuracy = (loss) => clamp(103.1668 * Math.exp(-0.04354 * loss) - 3.1669 + 1, 0, 100);
const cpOf = ({ cp, mate }) => (mate != null ? (mate > 0 ? 1000 : -1000) : clamp(cp, -1000, 1000));

// Static exchange evaluation: material the capturing side nets from `move` after all recaptures on that square.
function see(chess, move) {
  let gain = VAL[move.captured] ?? 0;
  if (move.promotion) gain += VAL[move.promotion] - 1;
  chess.move(move);
  const replies = chess
    .moves({ verbose: true })
    .filter((m) => m.to === move.to && m.captured)
    .sort((a, b) => VAL[a.piece] - VAL[b.piece]);
  const back = replies.length ? Math.max(0, see(chess, replies[0])) : 0;
  chess.undo();
  return gain - back;
}

// Biggest material win available by a single capture sequence for the side to move.
function bestCapture(fen, minVictim = 1) {
  const chess = new Chess(fen);
  let best = { gain: 0, move: null };
  for (const m of chess.moves({ verbose: true })) {
    if (!m.captured || VAL[m.captured] < minVictim) continue;
    const gain = see(chess, m);
    if (gain > best.gain) best = { gain, move: m };
  }
  return best;
}

function phaseOf(fen, ply) {
  const board = fen.split(" ")[0];
  let pieces = 0;
  let queens = 0;
  for (const c of board.toLowerCase()) {
    if (VAL[c]) pieces += c === "p" ? 0 : VAL[c];
    if (c === "q") queens++;
  }
  if (pieces <= 20 || (queens === 0 && pieces <= 26)) return "endgame";
  if (ply <= 20 && pieces >= 50) return "opening";
  return "middlegame";
}

function uciToSanLine(fen, pv, max = 6) {
  const chess = new Chess(fen);
  const out = [];
  for (const u of pv.slice(0, max)) {
    try {
      out.push(chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san);
    } catch {
      break;
    }
  }
  return out;
}

// Accuracy -> rating anchors. A single game is a noisy sample, so this is a "played like" figure, not a measurement.
const RATING_CURVE = [
  [30, 150], [45, 350], [55, 550], [63, 800], [70, 1050], [76, 1300], [81, 1550],
  [85, 1800], [88.5, 2050], [91.5, 2300], [94, 2550], [96.5, 2800], [98.5, 3050], [100, 3300],
];
function ratingFromAccuracy(acc) {
  if (acc <= RATING_CURVE[0][0]) return RATING_CURVE[0][1];
  for (let i = 1; i < RATING_CURVE.length; i++) {
    const [a1, r1] = RATING_CURVE[i];
    const [a0, r0] = RATING_CURVE[i - 1];
    if (acc <= a1) return r0 + ((acc - a0) / (a1 - a0)) * (r1 - r0);
  }
  return 3300;
}

function gameAccuracy(accs) {
  if (!accs.length) return null;
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 1), 0);
  return (mean + harmonic) / 2;
}

function sideSummary(plies, color) {
  const mine = plies.filter((p) => p.color === color);
  const judged = mine.filter((p) => p.cls !== "book");
  const counts = {};
  for (const p of mine) counts[p.cls] = (counts[p.cls] ?? 0) + 1;
  const accuracy = gameAccuracy(mine.map((p) => p.accuracy));
  const acpl = judged.length ? judged.reduce((a, p) => a + p.cpLoss, 0) / judged.length : 0;
  const phases = {};
  for (const ph of ["opening", "middlegame", "endgame"]) {
    const ms = mine.filter((p) => p.phase === ph);
    if (ms.length) phases[ph] = { moves: ms.length, accuracy: +gameAccuracy(ms.map((p) => p.accuracy)).toFixed(1) };
  }
  // Rate only the moves the player had to find themselves; long book sequences shouldn't inflate the estimate.
  const ratedAcc = judged.length ? gameAccuracy(judged.map((p) => p.accuracy)) : accuracy;
  let rating = ratingFromAccuracy(ratedAcc);
  // Clean but very short games tell us little: pull the estimate toward a club-level prior.
  const weight = clamp(judged.length / 20, 0.25, 1);
  rating = rating * weight + 1200 * (1 - weight);
  return {
    accuracy: accuracy == null ? null : +accuracy.toFixed(1),
    acpl: Math.round(acpl),
    rating: Math.round(clamp(rating, 100, 3300) / 50) * 50,
    confidence: judged.length >= 25 ? "decent" : judged.length >= 12 ? "rough" : "very rough",
    counts,
    phases,
  };
}

export async function analyzeGame({ sans, onProgress, depth }) {
  // 1. Replay the game.
  const chess = new Chess();
  const fens = [chess.fen()];
  const plies = sans.map((san, i) => {
    const fenBefore = chess.fen();
    const m = chess.move(san);
    fens.push(chess.fen());
    return {
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      color: m.color,
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ""),
      from: m.from,
      to: m.to,
      piece: m.piece,
      captured: m.captured ?? null,
      fenBefore,
    };
  });
  const final = chess;
  const terminal = final.isCheckmate() ? "checkmate" : final.isStalemate() ? "stalemate" : final.isDraw() ? "draw" : null;

  // 2. Engine evals for every position (the final one only if the game isn't over on the board).
  const raw = await evaluatePositions(
    fens.map((f, i) => (i === fens.length - 1 && terminal ? null : f)),
    { depth, onProgress },
  );

  const positions = fens.map((fen, i) => {
    const whiteToMove = fen.split(" ")[1] === "w";
    const sign = whiteToMove ? 1 : -1;
    let lines = raw[i].map((l) => ({ ...(l.mate != null ? { mate: l.mate } : { cp: l.cp }), pv: l.pv }));
    let score; // side-to-move POV
    if (!lines.length) score = terminal === "checkmate" ? { mate: -0 } : { cp: 0 };
    else score = lines[0].mate != null ? { mate: lines[0].mate } : { cp: lines[0].cp };
    const isMated = !lines.length && terminal === "checkmate";
    const stmWp = isMated ? 0 : winPct(score);
    const white = isMated
      ? { mate: 0, winner: whiteToMove ? "b" : "w" }
      : score.mate != null
        ? { mate: score.mate * sign }
        : { cp: score.cp * sign };
    return {
      fen,
      whiteToMove,
      lines,
      stmWp,
      stmCp: isMated ? -1000 : cpOf(score),
      stmMate: isMated ? 0 : score.mate ?? null,
      wp: +(whiteToMove ? stmWp : 100 - stmWp).toFixed(1), // White's win %
      ...white,
    };
  });

  // 3. Opening.
  const { opening, bookPlies } = identifyOpening(fens.slice(1));

  // 4. Judge each move.
  plies.forEach((p, i) => {
    const before = positions[i];
    const after = positions[i + 1];
    const best = before.lines[0];
    const second = before.lines[1];
    const isBest = !!best && best.pv[0] === p.uci;
    const wpBefore = before.stmWp;
    const wpAfter = 100 - after.stmWp;
    const loss = isBest ? 0 : Math.max(0, wpBefore - wpAfter);
    const cpLoss = isBest ? 0 : clamp(before.stmCp + after.stmCp, 0, 1000);

    p.phase = phaseOf(p.fenBefore, p.ply);
    p.isBest = isBest;
    p.loss = +loss.toFixed(1);
    p.cpLoss = cpLoss;
    p.accuracy = +moveAccuracy(loss).toFixed(1);
    p.bestUci = best?.pv[0] ?? null;
    p.bestSan = best ? uciToSanLine(p.fenBefore, best.pv, 1)[0] ?? null : null;
    p.bestWords = p.bestSan ? moveWords(p.fenBefore, p.bestSan) : null;
    p.bestLine = best ? uciToSanLine(p.fenBefore, best.pv) : [];
    p.reply = after.lines[0] ? uciToSanLine(after.fen, after.lines[0].pv) : [];
    p.tags = [];

    // Material offered: what the opponent can win by capturing right now, minus what this move just took.
    const oppCapture = bestCapture(after.fen, 3);
    const offered = oppCapture.gain - (VAL[p.captured] ?? 0);
    const prev = plies[i - 1];
    const isRecapture = !!p.captured && prev?.captured && prev.to === p.to;
    // Simply taking a loose piece is never a "great find".
    const freeCapture = !!p.captured && see(new Chess(p.fenBefore), { from: p.from, to: p.to, promotion: p.uci[4], captured: p.captured }) >= 2;

    let cls;
    if (p.ply <= bookPlies) cls = "book";
    else if (loss <= 2 && offered >= 2 && !isRecapture && wpAfter >= 45 && wpBefore <= 97 && p.piece !== "k") cls = "brilliant";
    else if (
      isBest && second && !isRecapture && !freeCapture &&
      wpBefore - winPct(second) >= 15 && winPct(second) < 75 && wpAfter >= 30
    ) cls = "great";
    else if (isBest) cls = "best";
    else if (loss <= 2) cls = "excellent";
    else if (loss <= 5) cls = "good";
    else if (loss <= 10) cls = "inaccuracy";
    else if (loss <= 20) cls = "mistake";
    else cls = "blunder";

    // A "miss": the opponent just erred and this move lets them off the hook.
    if (["inaccuracy", "mistake", "blunder"].includes(cls) && loss >= 10 && prev && ["mistake", "blunder", "miss"].includes(prev.cls) && wpBefore >= 60) {
      cls = "miss";
    }
    p.cls = cls;

    if (["inaccuracy", "mistake", "blunder", "miss"].includes(cls)) {
      if (before.stmMate > 0 && !(after.stmMate < 0)) p.tags.push("missed-mate");
      if (after.stmMate > 0 && !(before.stmMate < 0)) p.tags.push("allowed-mate");
      if (oppCapture.gain >= 2 && offered >= 2 && loss >= 10) {
        p.tags.push("hung-piece");
        p.hung = PIECE_NAME[oppCapture.move.captured];
      }
      const myCapture = bestCapture(p.fenBefore, 1);
      const bestMove = best ? best.pv[0] : "";
      if (myCapture.gain >= 2 && myCapture.move.from + myCapture.move.to === bestMove.slice(0, 4) && !isBest) p.tags.push("missed-capture");
    }
    delete p.fenBefore;
  });

  const result = terminal === "checkmate" ? (final.turn() === "w" ? "0-1" : "1-0") : terminal ? "1/2-1/2" : null;

  return {
    plies,
    positions: positions.map((p) => ({
      fen: p.fen,
      wp: p.wp,
      ...(p.mate != null ? { mate: p.mate } : { cp: p.cp }),
      ...(p.winner ? { winner: p.winner } : {}),
    })),
    opening,
    bookPlies,
    terminal,
    result,
    white: sideSummary(plies, "w"),
    black: sideSummary(plies, "b"),
  };
}

export const CLASS_LABEL = {
  book: "Book", brilliant: "Brilliant", great: "Great", best: "Best", excellent: "Excellent", good: "Good",
  inaccuracy: "Inaccuracy", mistake: "Mistake", miss: "Miss", blunder: "Blunder",
};

export function formatEval(pos) {
  if (pos.mate != null) return pos.mate === 0 ? "#" : `${pos.mate > 0 ? "+" : "-"}M${Math.abs(pos.mate)}`;
  const v = pos.cp / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}
