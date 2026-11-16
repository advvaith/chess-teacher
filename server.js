import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";
import express from "express";
import { analyzeGame } from "./lib/analyze.js";
import { evaluateOne } from "./lib/engine.js";
import { ChessComError, recentGames } from "./lib/chesscom.js";
import { basicCoach, coachGame, extractMoves } from "./lib/coach.js";
import { moveWords } from "./lib/facts.js";
import { describeError, hasKey, listModels, PROVIDERS } from "./lib/llm.js";
import { formatMoves, parseMoves } from "./lib/moves.js";
import { loadBook } from "./lib/openings.js";
import { buildProfile, deleteGame, forgetGamePatterns, gameListing, loadGame, loadPatterns, loadSettings, recordPatterns, saveGame, saveSettings } from "./lib/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "40mb" }));
app.use(express.static(path.join(here, "public")));
// The page uses the same rules library and move wording as the server.
app.get("/vendor/chess.js", (req, res) => res.sendFile(path.join(here, "node_modules/chess.js/dist/esm/chess.js")));
app.get("/vendor/facts.js", (req, res) => res.sendFile(path.join(here, "lib/facts.js")));

// Current provider + models, falling back to the first provider that has a key.
function currentSettings() {
  const s = loadSettings();
  if (!PROVIDERS[s.provider]) s.provider = Object.keys(PROVIDERS).find(hasKey) ?? "anthropic";
  return s;
}
const llmFor = (role) => {
  const s = currentSettings();
  return { provider: s.provider, model: s.models[s.provider]?.[role] || null };
};
const settingsPayload = () => ({
  ...currentSettings(),
  providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, name: p.name, env: p.env, hasKey: hasKey(id) })),
});

app.get("/api/settings", (req, res) => res.json(settingsPayload()));
app.put("/api/settings", (req, res) => {
  const { provider, coach, vision } = req.body;
  if (!PROVIDERS[provider]) return res.status(400).json({ error: "Unknown provider." });
  const s = currentSettings();
  s.provider = provider;
  const clean = (v, old) => (typeof v === "string" ? v.trim().slice(0, 200) : old);
  s.models[provider] = { coach: clean(coach, s.models[provider]?.coach), vision: clean(vision, s.models[provider]?.vision) };
  saveSettings({ provider: s.provider, models: s.models });
  res.json(settingsPayload());
});
app.get("/api/models", async (req, res) => {
  try {
    res.json(await listModels(req.query.provider));
  } catch (err) {
    res.status(502).json({ error: describeError(err, req.query.provider) });
  }
});

// Recent games from chess.com for a username.
app.get("/api/chesscom/:username", async (req, res) => {
  try {
    res.json(await recentGames(req.params.username));
  } catch (err) {
    if (!(err instanceof ChessComError)) console.error(err);
    res.status(err instanceof ChessComError ? 400 : 500).json({ error: err instanceof ChessComError ? err.message : "Couldn't load games from chess.com." });
  }
});

// Screenshot(s) -> verified move list.
app.post("/api/extract", async (req, res) => {
  const images = (req.body.images ?? []).filter((i) => /^image\/(png|jpeg|webp|gif)$/.test(i.mediaType) && typeof i.data === "string");
  if (!images.length) return res.status(400).json({ error: "No image received (PNG, JPEG, WebP or GIF)." });
  const llm = llmFor("vision");
  try {
    const out = await extractMoves(images, llm);
    res.json({
      // If the replay broke, hand back the raw reading so the player can fix the one bad move by hand.
      movesText: out.error ? out.raw.join(" ") : formatMoves(out.sans),
      count: out.sans.length,
      error: out.error?.message ?? null,
      white: out.white_player,
      black: out.black_player,
      result: out.result === "unknown" ? null : out.result,
      problems: out.problems,
    });
  } catch (err) {
    res.status(502).json({ error: describeError(err, llm.provider) });
  }
});

// Move list -> engine analysis -> coaching. Streams newline-delimited JSON events.
app.post("/api/analyze", async (req, res) => {
  const { movesText = "", color, white = null, black = null, result = null, source = null } = req.body;
  const rating = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);
  const ratings = { white: rating(req.body.whiteRating), black: rating(req.body.blackRating) };
  const parsed = parseMoves(movesText);
  if (parsed.error) return res.status(400).json({ error: parsed.error.message, legal: parsed.error.legal });
  if (color !== "w" && color !== "b") return res.status(400).json({ error: "Pick which colour you played." });

  res.setHeader("Content-Type", "application/x-ndjson");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");
  try {
    const analysis = await analyzeGame({
      sans: parsed.sans,
      onProgress: (done, total) => send({ type: "progress", done, total }),
    });
    const finalResult = analysis.result ?? (["1-0", "0-1", "1/2-1/2"].includes(result) ? result : null);
    const game = {
      id: `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`,
      createdAt: new Date().toISOString(),
      playedAt: Number(req.body.playedAt) > 0 ? new Date(Number(req.body.playedAt)).toISOString() : null,
      color,
      players: { white, black },
      ratings,
      source: typeof source === "string" && source.startsWith("https://www.chess.com/") ? source : null,
      result: finalResult,
      outcome: !finalResult ? null : finalResult === "1/2-1/2" ? "draw" : (finalResult === "1-0") === (color === "w") ? "win" : "loss",
      analysis,
      coach: null,
    };
    saveGame(game);
    send({ type: "game", game });

    const llm = llmFor("coach");
    try {
      game.coach = await coachGame(game, loadPatterns(), llm);
      recordPatterns(game, game.coach.patterns);
    } catch (err) {
      console.error("coach failed:", describeError(err, llm.provider));
      game.coach = { ...basicCoach(game), notice: describeError(err, llm.provider) };
    }
    saveGame(game);
    send({ type: "coach", coach: game.coach });
  } catch (err) {
    console.error(err);
    send({ type: "error", error: err.message ?? String(err) });
  }
  res.end();
});

app.get("/api/games", (req, res) => res.json(gameListing()));
app.get("/api/games/:id", (req, res) => {
  const game = loadGame(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });
  // Reviews saved before best moves were spelled out in full: fill the wording in on the way out.
  for (const p of game.analysis.plies) {
    if (p.bestSan && !p.bestWords) p.bestWords = moveWords(game.analysis.positions[p.ply - 1].fen, p.bestSan);
  }
  res.json(game);
});
// (Re)write the coaching for a saved game with the currently selected model. The engine analysis is reused.
const coaching = new Set();
app.post("/api/games/:id/coach", async (req, res) => {
  const game = loadGame(req.params.id);
  if (!game) return res.status(404).json({ error: "Game not found" });
  if (coaching.has(game.id)) return res.status(409).json({ error: "The coach is already writing this one up." });
  const llm = llmFor("coach");
  coaching.add(game.id);
  try {
    const known = loadPatterns()
      .map((p) => ({ ...p, occurrences: p.occurrences.filter((o) => o.gameId !== game.id) }))
      .filter((p) => p.occurrences.length);
    const coach = await coachGame(game, known, llm);
    // Only replace what was there once the new review has actually arrived.
    forgetGamePatterns(game.id);
    recordPatterns(game, coach.patterns);
    game.coach = coach;
    saveGame(game);
    res.json(coach);
  } catch (err) {
    console.error("coach failed:", describeError(err, llm.provider));
    res.status(502).json({ error: describeError(err, llm.provider) });
  } finally {
    coaching.delete(game.id);
  }
});

// Engine's view of any position, for trying out moves on the board. Scores are for the side to move.
const explored = new Map();
app.post("/api/explore", async (req, res) => {
  const fen = String(req.body?.fen ?? "").slice(0, 100);
  try {
    if (new Chess(fen).isGameOver()) return res.json({ lines: [] });
  } catch {
    return res.status(400).json({ error: "That isn't a legal position." });
  }
  try {
    if (!explored.has(fen)) {
      const lines = await evaluateOne(fen);
      if (explored.size >= 2000) explored.delete(explored.keys().next().value);
      explored.set(fen, lines.map((l) => ({ ...(l.mate != null ? { mate: l.mate } : { cp: l.cp }), pv: l.pv.slice(0, 6) })));
    }
    res.json({ lines: explored.get(fen) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "The engine couldn't look at that position." });
  }
});

app.delete("/api/games/:id", (req, res) => {
  deleteGame(req.params.id);
  res.json({ ok: true });
});
app.get("/api/profile", (req, res) => res.json(buildProfile()));

const port = Number(process.env.PORT) || 3000;
loadBook();
// Local-only by default; the Docker image sets HOST=0.0.0.0 so the published port works.
app.listen(port, process.env.HOST || "127.0.0.1", () => {
  console.log(`Chess teacher running at http://localhost:${port}`);
  const ready = Object.keys(PROVIDERS).filter(hasKey);
  console.log(ready.length ? `API keys found for: ${ready.map((p) => PROVIDERS[p].name).join(", ")}` : `No API key set (${Object.values(PROVIDERS).map((p) => p.env).join(" / ")}): screenshot reading and written coaching are off, engine review still works.`);
});
