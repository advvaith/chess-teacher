// Walkthrough comments written by code, not by a language model. Everything said here is either read off the
// board with the rules of chess (what a move captures, attacks, pins, forks...) or taken from the engine
// (what the best move was, what the best reply is, whether there is a forced mate).
import { Chess } from "chess.js";

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const other = (c) => (c === "w" ? "b" : "w");
const on = (p) => (p.type === "k" ? "the king" : `the ${NAME[p.type]} on ${p.square}`);
const list = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
// Where the captured piece actually stood (differs from the landing square for en passant).
const capSq = (m) => (m.flags.includes("e") ? m.to[0] + m.from[1] : m.to);
const pieces = (chess, color) => chess.board().flat().filter((p) => p && (!color || p.color === color));

// ---------- small board tools ----------

// Legal moves for a position, remembered: the same few positions are asked about many times per move.
const movesCache = new Map();
function legal(chess) {
  const key = chess.fen();
  let m = movesCache.get(key);
  if (!m) {
    if (movesCache.size > 4000) movesCache.clear();
    m = chess.moves({ verbose: true });
    movesCache.set(key, m);
  }
  return m;
}

// Material the capturing side nets from `move` after all the recaptures on that square.
function see(chess, move) {
  let gain = VAL[move.captured] ?? 0;
  if (move.promotion) gain += VAL[move.promotion] - 1;
  chess.move(move);
  const replies = chess.moves({ verbose: true }).filter((m) => m.to === move.to && m.captured).sort((a, b) => VAL[a.piece] - VAL[b.piece]);
  const back = replies.length ? Math.max(0, see(chess, replies[0])) : 0;
  chess.undo();
  return gain - back;
}

// Most the side to move can win by capturing on `sq` (0 if nothing profitable).
function gainOn(chess, sq) {
  let best = 0;
  for (const m of legal(chess)) if (m.to === sq && m.captured) best = Math.max(best, see(chess, m));
  return best;
}

// The same position with the other side to move. Null if that isn't a legal position (the mover is giving check).
function passTurn(fen) {
  const f = fen.split(" ");
  f[1] = other(f[1]);
  f[3] = "-";
  try {
    return new Chess(f.join(" "));
  } catch {
    return null;
  }
}

function tryMove(fen, move) {
  try {
    const chess = new Chess(fen);
    const m = chess.move(move);
    return { chess, m };
  } catch {
    return null;
  }
}

const coords = (sq) => [sq.charCodeAt(0) - 97, Number(sq[1]) - 1];
const sqOf = (f, r) => "abcdefgh"[f] + (r + 1);
const DIRS = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
};
DIRS.q = [...DIRS.b, ...DIRS.r];

// The first two pieces met along each line a bishop, rook or queen on `sq` looks down.
function rays(chess, sq, type) {
  const [f0, r0] = coords(sq);
  return (DIRS[type] ?? []).map(([df, dr]) => {
    const hit = [];
    for (let f = f0 + df, r = r0 + dr; f >= 0 && f < 8 && r >= 0 && r < 8 && hit.length < 2; f += df, r += dr) {
      const p = chess.get(sqOf(f, r));
      if (p) hit.push({ ...p, square: sqOf(f, r) });
    }
    return hit;
  });
}

function isPassed(chess, sq, color) {
  const [f, r] = coords(sq);
  return !pieces(chess, other(color)).some((p) => {
    if (p.type !== "p") return false;
    const [pf, pr] = coords(p.square);
    return Math.abs(pf - f) <= 1 && (color === "w" ? pr > r : pr < r);
  });
}

const HOME = { w: { n: ["b1", "g1"], b: ["c1", "f1"] }, b: { n: ["b8", "g8"], b: ["c8", "f8"] } };
const undeveloped = (chess, color) => pieces(chess, color).filter((p) => HOME[color][p.type]?.includes(p.square)).length;

// ---------- what a move does ----------

// Everything recognisable about playing `san` in `fen`. `line` is the engine's expected continuation after it
// (used to confirm that a trapped piece really is lost). Returns { m, tags: [{ key, text }] } where each text
// is a phrase that reads after "It ..." or "which ...".
function motifs(fen, san, { line = [], prevCaptureSq = null, moveNumber = 99 } = {}) {
  const made = tryMove(fen, san);
  if (!made) return null;
  const before = new Chess(fen);
  const { chess: after, m } = made;
  const c = m.color;
  const o = other(c);
  const tags = [];
  const add = (key, text) => tags.push({ key, text });
  const moved = after.get(m.to);
  const movedName = NAME[moved.type];
  const castle = m.flags.includes("k") || m.flags.includes("q");
  const enemy = pieces(after, o);
  const enemyKing = enemy.find((p) => p.type === "k");

  // Checkmate, stalemate.
  if (after.isCheckmate()) {
    const rank = enemyKing.square[1];
    const backRank = rank === (o === "w" ? "1" : "8") && ["r", "q"].includes(moved.type) && m.to[1] === rank;
    add("mate", backRank ? "is checkmate on the back rank: the king is boxed in by its own pieces" : "is checkmate");
    return { m, tags };
  }
  if (after.isStalemate()) {
    add("stalemate", "is stalemate: the other side has no legal move and is not in check, so the game is a draw");
    return { m, tags };
  }

  // Captures.
  if (m.captured) {
    const gain = see(before, m);
    const canRetake = legal(after).some((x) => x.to === m.to && x.captured);
    const victim = NAME[m.captured];
    const mine = NAME[m.piece];
    if (prevCaptureSq === m.to && gain >= 0) add("recapture", `takes back the ${victim}`);
    else if (gain >= VAL[m.captured] && !canRetake) add("win", `wins the ${victim} on ${capSq(m)} for free`);
    else if (gain > 0 && VAL[m.captured] > VAL[m.piece]) add("win", `wins the ${victim} on ${capSq(m)} for the less valuable ${mine}`);
    else if (gain > 0) add("win", `wins the ${victim} on ${capSq(m)}, which did not have enough defenders`);
    else if (gain === 0) add("trade", m.captured === m.piece ? `trades ${mine}s` : `trades the ${mine} for the ${victim}`);
    else add("badcapture", `takes the ${victim} on ${capSq(m)}, but gives up the more valuable ${mine} for it`);
  }
  if (m.promotion) add("promote", `promotes the pawn to a ${NAME[m.promotion]}`);

  // Is the piece that moved safe where it landed?
  const safe = gainOn(after, m.to) <= 0;
  const inCheck = after.isCheck();
  const checkers = inCheck ? after.attackers(enemyKing.square, c) : [];

  // What the mover now threatens to take (exact: give the mover a second move and count the exchanges).
  const again = inCheck ? null : passTurn(after.fen());
  const threatFrom = (fromSq) => {
    const out = [];
    for (const e of enemy) {
      if (e.type === "k") continue;
      let hit;
      if (again) {
        const cap = legal(again).find((x) => x.from === fromSq && x.to === e.square);
        hit = cap && see(again, cap) > 0;
      } else {
        // The other side is in check, so judge by value: a more valuable or an undefended piece is a target.
        const attacker = after.get(fromSq);
        hit = after.attackers(e.square, c).includes(fromSq) && (VAL[e.type] > VAL[attacker.type] || (!after.attackers(e.square, o).length && VAL[e.type] >= 3));
      }
      if (hit) out.push(e);
    }
    return out;
  };
  const wasThreat = (fromSq, e) => {
    const cap = legal(before).find((x) => x.from === fromSq && x.to === e.square);
    return !!cap && see(before, cap) > 0;
  };

  // Discovered attacks: another piece of the mover's now hits something because this piece stepped off the line.
  if (!castle) {
    const direct = checkers.includes(m.to);
    const uncovered = checkers.filter((s) => s !== m.to);
    if (direct && uncovered.length) add("doublecheck", "is a double check: two pieces give check at once, so the king has to move");
    else if (uncovered.length) add("discovered", `uncovers a check from ${on({ ...after.get(uncovered[0]), square: uncovered[0] })}`);
    for (const s of pieces(after, c)) {
      if (s.square === m.to || !DIRS[s.type] || !before.attackers(m.from, c).includes(s.square)) continue;
      const fresh = threatFrom(s.square).filter((e) => !before.attackers(e.square, c).includes(s.square) && VAL[e.type] >= 3);
      if (fresh.length) {
        add("discovered", `uncovers an attack on ${on(fresh[0])} from ${on(s)}`);
        break;
      }
    }
  }

  // Forks and simple threats by the piece that moved.
  const direct = checkers.includes(m.to);
  let targets = [];
  if (safe && !castle) {
    targets = threatFrom(m.to).filter((e) => !wasThreat(m.from, e));
    const big = targets.filter((e) => VAL[e.type] >= 3);
    if (big.length + (direct ? 1 : 0) >= 2) {
      add("fork", `is a fork: the ${movedName} attacks ${list([...(direct ? ["the king"] : []), ...big.map(on)])} at once`);
    } else if (targets.length && !direct) {
      const t = targets.sort((a, b) => VAL[b.type] - VAL[a.type])[0];
      add("threat", `attacks ${on(t)}`);
    }
  }

  // Pins and skewers along the lines of a bishop, rook or queen that just moved.
  if (safe && DIRS[moved.type]) {
    for (const [p1, p2] of rays(after, m.to, moved.type)) {
      if (!p1 || !p2 || p1.color !== o || p2.color !== o) continue;
      const bitesBack = after.attackers(m.to, o).includes(p1.square);
      if (p1.type === "k") {
        if (VAL[p2.type] >= 3 && (VAL[p2.type] > VAL[moved.type] || !after.attackers(p2.square, o).filter((s) => s !== p1.square).length)) {
          add("skewer", `is a skewer: the king has to step off the line, and ${on(p2)} behind it can then be taken`);
        }
      } else if (p2.type === "k") {
        if (VAL[p1.type] >= 3 && !bitesBack) add("pin", `pins ${on(p1)} to the king`);
      } else if (VAL[p1.type] > VAL[p2.type] && VAL[p1.type] > VAL[moved.type] && VAL[p2.type] >= 3 && !bitesBack && (VAL[p2.type] > VAL[moved.type] || !after.attackers(p2.square, o).filter((s) => s !== p1.square).length)) {
        add("skewer", `is a skewer: ${on(p1)} has to move away, and ${on(p2)} behind it can then be taken`);
      } else if (VAL[p2.type] > VAL[p1.type] && VAL[p2.type] > VAL[moved.type] && VAL[p1.type] >= 3 && !bitesBack) {
        add("pin", `pins ${on(p1)} against ${on(p2)} behind it`);
      }
    }
  }

  // Removing the defender: the captured piece was guarding something that can now be taken.
  if (m.captured && again) {
    for (const e of enemy) {
      if (e.type === "k" || e.square === m.to || VAL[e.type] < 3) continue;
      if (!before.attackers(e.square, o).includes(m.to)) continue;
      if (gainOn(again, e.square) > 0 && gainOn(before, e.square) <= 0) {
        add("undermine", `removes a defender of ${on(e)}`);
        break;
      }
    }
  }

  // Trapped piece: attacked, nowhere safe to go, and the engine's line does win it.
  if (again && line.length) {
    for (const e of enemy) {
      if (e.type === "k" || VAL[e.type] < 3 || gainOn(again, e.square) <= 0) continue;
      const escapes = legal(after).filter((x) => x.from === e.square);
      const stuck = escapes.every((x) => {
        after.move(x);
        const lost = gainOn(after, x.to) >= VAL[e.type] - (VAL[x.captured] ?? 0) && gainOn(after, x.to) > 0;
        after.undo();
        return lost;
      });
      if (!stuck) continue;
      // Follow the engine's line and see whether that piece is actually captured in the next few moves.
      const sim = new Chess(after.fen());
      let sq = e.square;
      let won = false;
      for (const s of line.slice(0, 4)) {
        let x;
        try {
          x = sim.move(s);
        } catch {
          break;
        }
        if (x.color === o && x.from === sq) sq = x.to;
        else if (x.color === c && x.to === sq && x.captured) {
          won = true;
          break;
        }
      }
      if (won) {
        add("trap", `traps ${on(e)}: it has no safe square to go to`);
        break;
      }
    }
  }

  // Threat of checkmate next move.
  if (again) {
    const mate = legal(again).find((x) => x.san.endsWith("#"));
    if (mate) add("matethreat", `threatens checkmate next move with the ${NAME[mate.piece]} ${mate.captured ? "taking on" : "to"} ${mate.to}`);
  }

  if (direct && !tags.some((t) => ["fork", "skewer", "doublecheck"].includes(t.key))) add("check", "gives check");

  // Looking after your own pieces.
  const wasInCheck = before.isCheck();
  if (wasInCheck) add("evade", m.piece === "k" ? "moves the king out of check" : m.captured ? "deals with the check by taking the checking piece" : "blocks the check");
  if (!castle && m.piece !== "k" && !m.captured) {
    const pass = wasInCheck ? null : passTurn(fen);
    if (pass && gainOn(pass, m.from) > 0 && safe) add("rescue", `moves the ${movedName} out of danger`);
  }
  if (safe && !wasInCheck) {
    const pass = passTurn(fen);
    if (pass && again) {
      for (const mine of pieces(after, c)) {
        if (mine.square === m.to || mine.type === "k" || VAL[mine.type] < 3) continue;
        if (!after.attackers(mine.square, c).includes(m.to)) continue;
        // It could be won before the move, and now it can't.
        const enemyTurn = after; // the other side is to move in `after`
        if (gainOn(pass, mine.square) > 0 && gainOn(enemyTurn, mine.square) <= 0) {
          add("defend", `defends ${on(mine)}, which was under attack`);
          break;
        }
      }
    }
  }

  // Quiet, useful things.
  if (castle) add("castle", "gets the king to safety and brings the rook into the game");
  if (m.piece === "p" && !m.promotion && isPassed(after, m.to, c)) {
    const rank = Number(m.to[1]);
    const left = c === "w" ? 8 - rank : rank - 1;
    if (left <= 2) add("passed", `pushes a passed pawn to ${m.to}, ${left === 1 ? "one step" : "two steps"} from becoming a queen`);
  }
  if (HOME[c][m.piece]?.includes(m.from) && moveNumber <= 15) add("develop", `develops the ${movedName}`);
  if (m.piece === "p" && moveNumber <= 10 && ["d4", "e4", "d5", "e5"].includes(m.to) && !m.captured) add("centre", "takes space in the centre");
  if (m.piece === "r" && !m.captured && !pieces(after).some((p) => p.type === "p" && p.square[0] === m.to[0])) add("openfile", `puts the rook on the open ${m.to[0]}-file`);
  if (tags.at(-1)?.key === "openfile" && m.from[0] === m.to[0]) tags.pop();

  return { m, tags, safe };
}

const TACTICS = ["mate", "win", "doublecheck", "discovered", "fork", "skewer", "pin", "undermine", "trap", "matethreat"];
const ORDER = [...TACTICS, "recapture", "promote", "trade", "threat", "check", "defend", "rescue", "evade", "castle", "passed", "develop", "centre", "openfile", "badcapture", "stalemate"];
const ranked = (tags) => [...tags].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
const top = (tags, n = 2) => {
  const seen = new Set();
  return ranked(tags).filter((t) => !seen.has(t.key) && seen.add(t.key)).slice(0, n).map((t) => t.text);
};

// Material change for `color` over a line of moves from `fen`.
function swing(fen, sans, color) {
  const chess = new Chess(fen);
  const count = () => pieces(chess).reduce((s, p) => s + (p.color === color ? VAL[p.type] : -VAL[p.type]), 0);
  const start = count();
  for (const s of sans) {
    try {
      chess.move(s);
    } catch {
      break;
    }
  }
  return count() - start;
}

const words = (m) => {
  if (m.flags.includes("k")) return "castling kingside";
  if (m.flags.includes("q")) return "castling queenside";
  if (m.flags.includes("e")) return `pawn from ${m.from} takes the pawn on ${capSq(m)} en passant`;
  return `${NAME[m.piece]} from ${m.from} ${m.captured ? `takes the ${NAME[m.captured]} on ${m.to}` : `to ${m.to}`}${m.promotion ? `, promoting to a ${NAME[m.promotion]}` : ""}`;
};

// ---------- one move's comment ----------

function explainPly(a, i) {
  const p = a.plies[i];
  const before = a.positions[i].fen;
  const after = a.positions[i + 1].fen;
  const c = p.color;
  const wp = (pos) => (c === "w" ? pos.wp : 100 - pos.wp);
  const wpB = wp(a.positions[i]);
  const wpA = wp(a.positions[i + 1]);
  const prev = a.plies[i - 1];
  const ctx = { prevCaptureSq: prev?.captured ? prev.to : null, moveNumber: p.moveNumber };
  const mine = motifs(before, p.san, { ...ctx, line: p.reply });
  if (!mine) return null;
  const did = top(mine.tags);
  const itDoes = did.length ? ` It ${did[0]}.${did[1] ? ` It also ${did[1]}.` : ""}` : "";
  const top1 = p.isBest || p.cls === "great";
  const standing = wpA >= 75 ? " It keeps the winning advantage." : wpA <= 25 ? (top1 ? " It puts up the most resistance in a difficult position." : " A reasonable try in a difficult position.") : " It keeps the game balanced.";

  if (mine.tags.some((t) => t.key === "mate")) return `Checkmate.${mine.tags[0].text.includes("back rank") ? " A back-rank mate: the king is boxed in by its own pieces." : ""}`;
  if (p.cls === "book") return `Book move${a.opening ? `: part of the ${a.opening.name}` : ""}.${did.length ? ` It ${did[0]}.` : ""}`;
  if (p.cls === "forced") {
    const how = mine.tags.find((t) => t.key === "evade");
    return `Forced: this was the only legal move.${how ? ` It ${how.text}.` : ""}`;
  }

  const good = ["brilliant", "great", "best", "excellent", "good"].includes(p.cls);
  if (good) {
    let lead;
    if (p.cls === "brilliant") {
      // What is being offered: the most valuable thing the other side can now take.
      const chess = new Chess(after);
      const offer = chess.moves({ verbose: true }).filter((x) => x.captured && VAL[x.captured] >= 3).map((x) => ({ x, g: see(chess, x) })).sort((x, y) => y.g - x.g)[0];
      lead = offer ? `Brilliant! This offers the ${NAME[offer.x.captured]} on ${offer.x.to} as a sacrifice, and the engine confirms it works.` : "Brilliant! A sacrifice that the engine confirms is the strongest move.";
    } else if (p.cls === "great") {
      lead = wpB < 40 && wpA >= 40 ? "Great move: the one move that gets back into the game." : wpB < 70 && wpA >= 70 ? "Great move: the one move that takes over the game." : "Great move: the only good move here, everything else was clearly worse.";
    } else lead = { best: "Best move.", excellent: "Excellent move.", good: "Good move." }[p.cls];
    let text = lead + (itDoes || (p.cls === "brilliant" ? "" : standing));
    if (!p.isBest && p.bestSan) {
      const b = tryMove(before, p.bestSan);
      const better = motifs(before, p.bestSan, { ...ctx, line: p.bestLine.slice(1) });
      const why = better ? top(better.tags.filter((t) => TACTICS.includes(t.key)), 1)[0] : null;
      const mate = better?.tags.some((t) => t.key === "mate");
      if (b && mate) text += ` There was a quicker finish, though: ${words(b.m)} ${why}.`;
      else if (b) text += ` The engine's first choice was ${words(b.m)}${why ? `, which ${why}` : ", but there is very little in it"}.`;
    }
    return text;
  }

  // ----- inaccuracy, mistake, miss, blunder -----
  const out = [];
  if (p.cls === "miss") out.push("The other side had just slipped, and this lets them off the hook.");
  const mateFor = (pos) => (pos.mate != null && pos.mate !== 0 ? (pos.mate > 0 ? "w" : "b") : null);
  const best = p.bestSan ? tryMove(before, p.bestSan) : null;
  const bestMotifs = p.bestSan ? motifs(before, p.bestSan, { ...ctx, line: p.bestLine.slice(1) }) : null;
  const reply = p.reply[0] ? tryMove(after, p.reply[0]) : null;
  const replyMotifs = p.reply[0] ? motifs(after, p.reply[0], { prevCaptureSq: p.captured ? p.to : null, moveNumber: p.moveNumber, line: p.reply.slice(1) }) : null;
  let problem = null;
  let bestSaid = false;

  if (mine.tags.some((t) => t.key === "stalemate")) problem = "This is stalemate: the other side has no legal move and is not in check, so the game is drawn.";
  else if (mateFor(a.positions[i]) === c && mateFor(a.positions[i + 1]) !== c && best) {
    const n = Math.abs(a.positions[i].mate);
    problem = `This misses a forced checkmate${n === 1 ? " in one move" : ` in ${n} moves`}: ${words(best.m)}${n === 1 ? " was mate on the spot" : " starts it"}.`;
    bestSaid = true;
  } else if (mateFor(a.positions[i + 1]) === other(c) && mateFor(a.positions[i]) !== other(c) && reply) {
    const n = Math.abs(a.positions[i + 1].mate);
    problem = `This allows a forced checkmate${n === 1 ? " next move" : ` in ${n} moves`}, starting with ${words(reply.m)}.`;
  } else if (reply?.m.captured && see(new Chess(after), reply.m) > 0) {
    // The reply simply wins material by capturing.
    const r = reply.m;
    const chessA = new Chess(after);
    const victim = NAME[r.captured];
    const taker = `the ${NAME[r.piece]} on ${r.from}`;
    const at = capSq(r);
    const defenders = chessA.attackers(r.to, c).length;
    const how = !defenders ? "and nothing can take back" : VAL[r.piece] < VAL[r.captured] ? `and the ${victim} is worth more than the ${NAME[r.piece]}` : "and it has more attackers than defenders";
    if (at === p.to && p.captured) problem = `This takes the ${NAME[p.captured]}, but then ${taker} takes the ${victim}, ${how}.`;
    else if (at === p.to) problem = `This puts the ${victim} on ${at} where ${taker} can take it, ${how}.`;
    else if (new Chess(before).attackers(at, other(c)).includes(r.from)) problem = `This ignores the attack on the ${victim} on ${at}: ${taker} can take it, ${how}.`;
    else problem = `This leaves the ${victim} on ${at} hanging: ${taker} can take it, ${how}.`;
    const extra = replyMotifs ? top(replyMotifs.tags.filter((t) => ["fork", "skewer", "pin", "discovered", "doublecheck", "matethreat"].includes(t.key)), 1)[0] : null;
    if (extra) problem += ` That capture also ${extra}.`;
  } else if (replyMotifs && reply) {
    const tactic = top(replyMotifs.tags.filter((t) => TACTICS.includes(t.key)), 1)[0];
    if (tactic) problem = `This allows ${words(reply.m)}, which ${tactic}.`;
    else if (swing(after, p.reply, c) <= -2) problem = `This loses material: after ${words(reply.m)}, the engine's line comes out ahead for the other side.`;
  }

  // Nothing concrete went wrong, so say what was missed, or which principle the move goes against.
  const bestTactic = bestMotifs ? top(bestMotifs.tags.filter((t) => TACTICS.includes(t.key)), 1)[0] : null;
  let generic = false;
  if (!problem) {
    const chessB = new Chess(before);
    const rights = before.split(" ")[2];
    const canCastle = c === "w" ? /[KQ]/.test(rights) : /[kq]/.test(rights);
    const queens = pieces(chessB).filter((x) => x.type === "q").length;
    const material = bestMotifs?.tags.some((t) => ["win", "fork", "skewer", "trap", "undermine", "discovered", "doublecheck"].includes(t.key)) || (best && swing(before, p.bestLine, c) >= 2);
    if (material) problem = p.cls === "miss" ? "" : "This misses a chance to win material.";
    else if (bestTactic) problem = p.cls === "miss" ? "" : "This misses a stronger move.";
    else if (p.piece === "k" && canCastle && !mine.m.flags.match(/[kq]/) && queens === 2 && !chessB.isCheck()) problem = "This gives up the right to castle, so the king stays in the middle.";
    else if (p.moveNumber <= 12 && undeveloped(chessB, c) >= 2 && !HOME[c][p.piece]?.includes(p.from) && ["n", "b", "q"].includes(p.piece) && !p.captured) {
      problem = p.piece === "q" ? "This brings the queen out while the knights and bishops are still at home, where it can be chased around." : `This moves the ${NAME[p.piece]} again while other pieces are still waiting to be developed.`;
    } else generic = true;
    if (!generic) {
      // a concrete reason was found above
    } else if (wpB >= 70 && wpA >= 70) problem = "Still winning, but this makes the job harder than it needed to be.";
    else if (wpB >= 70 && wpA <= 30) problem = "This turns a winning position into a losing one.";
    else if (wpB >= 70) problem = "This gives away the winning advantage: the game is close to level again.";
    else if (wpB > 30 && wpA <= 30) problem = "This hands the other side a clear advantage.";
    else if (wpB > 30) problem = "This gives the other side the easier game.";
    else problem = "This makes a difficult position worse.";
  }
  if (generic && reply && !mine.tags.some((t) => t.key === "stalemate")) {
    const does = replyMotifs ? top(replyMotifs.tags.filter((t) => [...TACTICS, "threat", "check", "passed", "promote"].includes(t.key)), 1)[0] : null;
    if (does) problem = `${problem.replace(/\.$/, "")}: the strongest reply is ${words(reply.m)}, which ${does}.`;
  }
  if (problem && !(generic && p.cls === "miss")) out.push(problem);

  if (best && !bestSaid) {
    const does = bestMotifs ? top(bestMotifs.tags, 1)[0] : null;
    let line = `Best was ${words(best.m)}${does ? `, which ${does}` : ""}.`;
    if (!does && swing(before, p.bestLine, c) >= 2) line = `Best was ${words(best.m)}, which starts a sequence that wins material.`;
    out.push(line);
  }
  return out.join(" ");
}

// Adds a written note to every move, and marks moves that were the only legal one as "forced".
// Safe to run again on a game that already has them. Returns true if anything was (re)written.
export const NOTES_VERSION = 1;
export function annotate(game) {
  const a = game.analysis;
  if (a.notes === NOTES_VERSION) return false;
  a.notes = NOTES_VERSION;
  for (let i = 0; i < a.plies.length; i++) {
    const p = a.plies[i];
    try {
      if (p.cls !== "book" && p.cls !== "forced" && new Chess(a.positions[i].fen).moves().length === 1) {
        const side = p.color === "w" ? a.white : a.black;
        side.counts[p.cls] = Math.max(0, (side.counts[p.cls] ?? 1) - 1);
        if (!side.counts[p.cls]) delete side.counts[p.cls];
        side.counts.forced = (side.counts.forced ?? 0) + 1;
        p.cls = "forced";
      }
      p.note = explainPly(a, i);
    } catch (err) {
      console.error(`couldn't explain ply ${p.ply}:`, err.message);
      p.note = null;
    }
  }
  return true;
}
