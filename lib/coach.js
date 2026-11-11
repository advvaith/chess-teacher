// The two model calls: reading the move list off a screenshot, and writing the coaching commentary.
import { z } from "zod";
import { CLASS_LABEL, formatEval } from "./analyze.js";
import { completeJson } from "./llm.js";
import { parseMoves } from "./moves.js";
import { describeMove, plainMoves } from "../public/words.js";

// ---------- 1. Screenshot -> moves ----------

const Extraction = z.object({
  moves: z.array(z.string()).describe("Every half-move in order (White, Black, White, ...) in standard algebraic notation with piece letters, e.g. Nf3, exd5, O-O, e8=Q+, Qxf7#."),
  first_move_number: z.int().describe("The move number the visible list starts at. 1 if the list starts from the beginning of the game."),
  white_player: z.string().nullable(),
  black_player: z.string().nullable(),
  result: z.enum(["1-0", "0-1", "1/2-1/2", "unknown"]),
  problems: z.string().nullable().describe("Anything cut off, blurry or ambiguous. Null if the list was fully readable."),
});

const EXTRACT_PROMPT = `These are screenshots of the move list from a chess game (the side panel on chess.com or a similar site). If there are several images they are consecutive parts of the same game, in order, and may overlap.

Read out every move in order. Rules:
- The panel shows a move number, then White's move, then Black's move. Ignore clock times, evaluation numbers, move-quality icons and anything else that isn't a move.
- Pieces are often drawn as small figurine icons instead of letters. Convert them: king K, queen Q, rook R, bishop B, knight N. Pawn moves have no letter.
- Keep capture marks (x), checks (+), mate (#), promotions (=Q) and disambiguation (Nbd7, R1e2) exactly as shown.
- first_move_number is the move number the visible list starts at: 1 when it starts from the beginning of the game.
- Don't skip, guess or tidy up moves. The list is checked against the rules of chess afterwards, so accuracy on each character matters more than anything else.`;

// llm = { provider, model }
export async function extractMoves(images, llm) {
  const messages = [{ role: "user", text: EXTRACT_PROMPT, images }];
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: out, raw } = await completeJson({
      ...llm,
      system: "You transcribe chess move lists from screenshots, exactly as shown.",
      messages,
      schema: Extraction,
    });
    const parsed = out.first_move_number > 1
      ? { sans: [], error: { message: `The screenshot starts at move ${out.first_move_number}. I need the list from move 1, so add the earlier part of the game.`, ply: 1, legal: [] } }
      : parseMoves(out.moves);
    last = { ...out, ...parsed, raw: out.moves };
    if (!parsed.error || out.first_move_number > 1) break;
    // Illegal move: show the model exactly where the replay broke and let it re-read that spot.
    messages.push({ role: "assistant", text: raw });
    messages.push({
      role: "user",
      text: `I replayed your list on a board and it breaks: ${parsed.error.message} Everything before it was legal (${parsed.sans.length} half-moves). The legal moves in that position are: ${parsed.error.legal.join(", ")}. Look at the image again around that point — a misread figurine, file letter or a skipped move is the usual cause — and give the full corrected list.`,
    });
  }
  return last;
}

// ---------- 2. Analysis -> coaching ----------

const Coaching = z.object({
  headline: z.string().describe("One short line that captures the story of the game."),
  summary: z.string().describe("The story of the game in 3-5 sentences, addressed to the student."),
  opening: z.string().describe("2-3 sentences: what this opening is trying to do and how well both sides handled it."),
  student_rating_reason: z.string().describe("1-2 sentences on why the student's play looked like the estimated rating."),
  opponent_rating_reason: z.string().describe("1-2 sentences on why the opponent's play looked like the estimated rating."),
  moves: z.array(z.object({ ply: z.int(), comment: z.string() })),
  turning_points: z.array(z.object({ ply: z.int(), title: z.string(), explanation: z.string() })),
  patterns: z.array(
    z.object({
      id: z.string().describe("Stable kebab-case id. Reuse an id from the known patterns list when it is the same habit."),
      name: z.string(),
      kind: z.enum(["strength", "weakness"]),
      description: z.string().describe("What the habit is, in general terms: 1-2 sentences that would still be true when read next to any other game. No moves or details from this game."),
      in_this_game: z.string().describe("How the habit showed up in this particular game, in 1-2 sentences."),
      advice: z.string().describe("One concrete thing to do about it (or to keep doing)."),
      plies: z.array(z.int()).describe("Plies in this game where it showed up."),
    }),
  ),
  takeaways: z.array(z.string()).describe("The 3 most useful things to work on, most important first."),
});

const COACH_SYSTEM = `You are a chess coach reviewing one of your student's games with them. You speak to the student directly ("you"), in a warm, plain, direct voice — like a strong club player sitting next to them at the board, not a textbook. Keep the level of explanation matched to the rating their play suggests.

You are given a full engine analysis: every move with its classification, the evaluation before and after, the engine's preferred move and main line, and the position (FEN). The classifications and evaluations are fixed and shown to the student next to your words, so never contradict them and don't restate numbers the student can already see. Your job is the part the engine can't do: the why.

How to comment on moves:
- Explain ideas in terms of what is happening on the board: which piece or square is the point, what the threat was, what the move allows. Use the engine lines to ground every tactical claim; if you can't verify a tactic from the FEN and the lines given, describe the idea more generally instead of inventing a variation.
- For a mistake, blunder or miss: say what went wrong, what the better move was aiming for, and what the student could have asked themselves to find it.
- For a best, great or brilliant move: say what made it good, so the student knows what to repeat. Praise only what is specific.
- Book moves: one comment for the opening as a whole is enough; comment on individual book moves only where there's an idea worth knowing.
- 1-3 sentences per move.

How to write (this applies to every field, including titles, patterns and takeaways):
- The student does not read chess notation. Never write moves as notation: no "Nxd5", "exd5", "Qh5+", "O-O", "12...Rd8". Say them in words, naming the pieces involved: "your knight takes the pawn on d5", "the pawn on e4 captures on d5", "queen to h5 with check", "castling kingside", "the rook comes to d8".
- Square, file and rank names are fine ("the d5 square", "the open e-file", "your back rank"); the student has the board with coordinates in front of them.
- When you describe a line of play, tell it as a short sequence in words, two or three moves at most ("the bishop takes on f7 with check, and after the king takes back, the knight jumps to g5 with check and wins the queen"). Do not list long variations.
- Use plain language. If a chess term is needed (fork, pin, skewer, tempo, outpost), say in a few words what it means the first time.

Which moves to cover in "moves": every move the student played once the game left book, and every opponent move classified as inaccuracy, mistake, miss, blunder, great or brilliant, plus any other opponent move that matters to the story. Quiet, obvious moves can get a single short sentence.

turning_points: the 2-5 moments where the game was actually decided, by either side.

patterns: habits visible in the student's play in this game, both strengths and weaknesses (2-5). A pattern is a recurring way of thinking ("moves the same piece twice in the opening", "misses backward knight moves", "trades when ahead"), not a single mistake. You are also given the patterns recorded from the student's earlier games: when one of those shows up again reuse its exact id so it is tracked over time, and say if it is recurring. Only report a pattern there is evidence for in this game. Keep the two parts apart: "description" is the habit itself in general terms (it is shown on the student's long-term profile, next to many games), and "in_this_game" is the evidence from this game.

A ply is one half-move: ply 1 is White's first move, ply 2 is Black's first move.`;

function coachInput(game, knownPatterns) {
  const a = game.analysis;
  const me = game.color === "w" ? "White" : "Black";
  const lines = a.plies.map((p) => {
    const who = p.color === game.color ? "student" : "opponent";
    const parts = [
      `ply ${p.ply} | ${p.moveNumber}${p.color === "w" ? "." : "..."} ${p.san} | ${who} | ${CLASS_LABEL[p.cls]}`,
      `eval ${formatEval(a.positions[p.ply - 1])} -> ${formatEval(a.positions[p.ply])}`,
    ];
    if (!p.isBest && p.bestSan && p.cls !== "book") parts.push(`engine preferred ${p.bestLine.join(" ")}`);
    if (p.reply.length) parts.push(`engine continuation after the move: ${p.reply.join(" ")}`);
    if (p.tags.length) parts.push(`tags: ${p.tags.join(", ")}`);
    parts.push(`${p.phase} | FEN after: ${a.positions[p.ply].fen}`);
    return parts.join(" | ");
  });
  const side = (s) => `accuracy ${s.accuracy}%, average centipawn loss ${s.acpl}, played like roughly ${s.rating} (${s.confidence} estimate), moves: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(", ")}`;
  return `The student played ${me}${game.players.white || game.players.black ? ` (White: ${game.players.white ?? "?"}, Black: ${game.players.black ?? "?"})` : ""}.
${game.ratings?.white || game.ratings?.black ? `Actual ratings going into the game: White ${game.ratings.white ?? "?"}, Black ${game.ratings.black ?? "?"}. Pitch your explanations at the student's actual level, and compare it with how they played here.\n` : ""}Result: ${game.result ?? "unknown"}${a.terminal ? ` (${a.terminal})` : " (the game ended by resignation, time or agreement — the move list just stops)"}.
Opening: ${a.opening ? `${a.opening.name} (${a.opening.eco})` : "not in the opening book"}; the game followed known theory for ${a.bookPlies} plies.
White: ${side(a.white)}
Black: ${side(a.black)}
Evaluations are from White's point of view, in pawns (M3 = mate in 3).

Moves:
${lines.join("\n")}

Patterns recorded from the student's earlier games (reuse ids where they recur):
${knownPatterns.length ? knownPatterns.map((p) => `- ${p.id} (${p.kind}, seen in ${p.occurrences.length} earlier game${p.occurrences.length === 1 ? "" : "s"}): ${p.name} — ${p.description}`).join("\n") : "(none yet — this is the first reviewed game)"}`;
}

export async function coachGame(game, knownPatterns, llm) {
  const { data: coach } = await completeJson({
    ...llm,
    system: COACH_SYSTEM,
    messages: [{ role: "user", text: coachInput(game, knownPatterns) }],
    schema: Coaching,
    maxTokens: 32000,
  });
  coach.model = `${llm.provider}/${llm.model}`;
  // Safety net: put any notation the model still used into words.
  for (const k of ["headline", "summary", "opening", "student_rating_reason", "opponent_rating_reason"]) coach[k] = plainMoves(coach[k]);
  for (const m of coach.moves) m.comment = plainMoves(m.comment);
  for (const t of coach.turning_points) Object.assign(t, { title: plainMoves(t.title), explanation: plainMoves(t.explanation) });
  for (const p of coach.patterns) Object.assign(p, { name: plainMoves(p.name), description: plainMoves(p.description), in_this_game: plainMoves(p.in_this_game), advice: plainMoves(p.advice) });
  coach.takeaways = coach.takeaways.map(plainMoves);
  const n = game.analysis.plies.length;
  coach.moves = coach.moves.filter((m) => m.ply >= 1 && m.ply <= n);
  coach.turning_points = coach.turning_points.filter((t) => t.ply >= 1 && t.ply <= n);
  coach.patterns.forEach((p) => {
    p.id = p.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pattern";
    p.plies = p.plies.filter((x) => x >= 1 && x <= n);
  });
  return coach;
}

// ---------- Engine-only fallback when no model is available ----------

export function basicCoach(game) {
  const a = game.analysis;
  const moves = a.plies
    .filter((p) => p.cls !== "book")
    .map((p) => {
      const better = ""; // the page already shows the engine's preferred line under each comment
      const extra = p.tags.includes("hung-piece") ? ` It leaves the ${p.hung} to be won.` : p.tags.includes("allowed-mate") ? " It allows a forced mate." : p.tags.includes("missed-mate") ? " There was a forced mate here." : "";
      const text = {
        brilliant: "A sacrifice that works — the engine agrees this is the strongest move.",
        great: "The only move that keeps things on track here, and you found it.",
        best: "The engine's top choice.",
        excellent: "Nearly as good as the engine's first choice." + better,
        good: "A reasonable move, slightly short of the best." + better,
        inaccuracy: "A small slip that gives away some of the position." + extra + better,
        mistake: "This gives away a real chunk of the evaluation." + extra + better,
        miss: "The opponent's last move was an error and this doesn't punish it." + extra + better,
        blunder: "This changes the result of the game." + extra + better,
      }[p.cls];
      return { ply: p.ply, comment: text };
    });
  const swings = a.plies.filter((p) => ["blunder", "miss", "mistake"].includes(p.cls)).sort((x, y) => y.loss - x.loss).slice(0, 4).sort((x, y) => x.ply - y.ply);
  return {
    basic: true,
    headline: a.opening ? a.opening.name : "Game review",
    summary: "This is the engine-only review: classifications, evaluations and best moves are all here, but the written coaching needs a model and API key set up.",
    opening: a.opening ? `${a.opening.name} (${a.opening.eco}). The game followed known theory for ${a.bookPlies} half-moves.` : "This move order isn't in the opening book.",
    student_rating_reason: "",
    opponent_rating_reason: "",
    moves,
    turning_points: swings.map((p) => ({ ply: p.ply, title: CLASS_LABEL[p.cls], explanation: `Cost about ${Math.round(p.loss)}% winning chances. Better was ${describeMove(p.bestSan)}.` })),
    patterns: [],
    takeaways: [],
  };
}
