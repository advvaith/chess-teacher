// Saved games + the running record of patterns in the player's games (plain JSON files in data/).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const GAMES = path.join(here, "..", "data", "games");
const PATTERNS = path.join(here, "..", "data", "patterns.json");
fs.mkdirSync(GAMES, { recursive: true });

const SETTINGS = path.join(here, "..", "data", "settings.json");

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const safeId = (id) => /^[a-z0-9-]+$/i.test(id);

export function saveGame(game) {
  fs.writeFileSync(path.join(GAMES, `${game.id}.json`), JSON.stringify(game));
}

export function loadGame(id) {
  return safeId(id) ? readJson(path.join(GAMES, `${id}.json`), null) : null;
}

export function deleteGame(id) {
  if (!safeId(id)) return;
  fs.rmSync(path.join(GAMES, `${id}.json`), { force: true });
  forgetGamePatterns(id);
}

// Drop one game's contribution to the pattern record (before deleting it or re-writing its coaching).
export function forgetGamePatterns(id) {
  const patterns = loadPatterns();
  for (const p of patterns) p.occurrences = p.occurrences.filter((o) => o.gameId !== id);
  fs.writeFileSync(PATTERNS, JSON.stringify(patterns.filter((p) => p.occurrences.length), null, 2));
}

export function allGames() {
  return fs
    .readdirSync(GAMES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(GAMES, f), null))
    .filter(Boolean)
    .sort((a, b) => when(b).localeCompare(when(a)));
}

export const loadPatterns = () => readJson(PATTERNS, []);

// Merge the coach's patterns for one game into the long-running list.
export function recordPatterns(game, patterns) {
  const all = loadPatterns();
  for (const p of patterns) {
    let entry = all.find((e) => e.id === p.id);
    if (!entry) {
      entry = { id: p.id, name: p.name, kind: p.kind, description: p.description, advice: p.advice, occurrences: [] };
      all.push(entry);
    }
    entry.description = p.description;
    entry.advice = p.advice;
    entry.occurrences = entry.occurrences.filter((o) => o.gameId !== game.id);
    entry.name = p.name;
    entry.occurrences.push({ gameId: game.id, date: game.playedAt ?? game.createdAt, plies: p.plies, note: p.in_this_game ?? null });
  }
  fs.writeFileSync(PATTERNS, JSON.stringify(all, null, 2));
}

// When the game was played if known (chess.com imports), otherwise when it was reviewed.
const when = (g) => g.playedAt ?? g.createdAt;
const label = (g) => ({ opponent: (g.color === "w" ? g.players.black : g.players.white) ?? null, outcome: g.outcome ?? null, played: !!g.playedAt });

const ERRORS = ["inaccuracy", "mistake", "miss", "blunder"];

// How many of the most recent games the profile and the coach look at unless told otherwise. A habit that has
// been fixed should drop off the list after a handful of clean games, not stay there forever.
export const RECENT = 10;

// Each recorded pattern with how often it showed up in the latest `last` games (0 = every game), and in the
// same number of games before those, so the page can show whether a habit is fading or growing.
function patternWindow(all, last, skipId) {
  const games = skipId ? all.filter((g) => g.id !== skipId) : all;
  const recent = last > 0 ? games.slice(0, last) : games;
  const earlier = last > 0 ? games.slice(last, last * 2) : [];
  const byId = Object.fromEntries(games.map((g) => [g.id, g]));
  const inRecent = new Set(recent.map((g) => g.id));
  const inEarlier = new Set(earlier.map((g) => g.id));
  return loadPatterns()
    .map((p) => {
      // Describe each occurrence by the game it came from, newest first.
      const every = p.occurrences
        .filter((o) => byId[o.gameId])
        .map((o) => ({ ...o, date: when(byId[o.gameId]), ...label(byId[o.gameId]) }))
        .sort((x, y) => y.date.localeCompare(x.date));
      const occurrences = every.filter((o) => inRecent.has(o.gameId));
      return {
        ...p,
        occurrences,
        games: occurrences.length,
        of: recent.length,
        before: every.filter((o) => inEarlier.has(o.gameId)).length,
        beforeOf: earlier.length,
        total: every.length,
        lastSeen: every[0]?.date ?? null,
      };
    })
    .filter((p) => p.total)
    .sort((x, y) => y.games - x.games || (y.lastSeen ?? "").localeCompare(x.lastSeen ?? ""));
}

// What the coach is told about the student's other games when it reviews one: every known habit (so ids stay
// stable), with how often each has shown up lately.
export const patternsForCoach = (skipId) => patternWindow(allGames(), RECENT, skipId);

// Cross-game picture of the player, computed from the saved engine data. Looks at the latest `last` games only
// (0 = all of them); the game-by-game list always covers everything.
export function buildProfile(last = RECENT) {
  const everything = allGames();
  const games = last > 0 ? everything.slice(0, last) : everything;
  const row = (g) => {
    const me = g.analysis[g.color === "w" ? "white" : "black"];
    return { id: g.id, date: when(g), ...label(g), opening: g.analysis.opening?.name ?? null, accuracy: me.accuracy, rating: me.rating };
  };
  const stats = {
    games: games.length,
    total: everything.length,
    window: last > 0 ? last : 0,
    record: { win: 0, loss: 0, draw: 0, unknown: 0 },
    avgAccuracy: null,
    avgRating: null,
    trend: everything.map(row),
    phases: {},
    openings: {},
    tags: {},
    errorsByPiece: {},
    counts: {},
  };
  const phaseAcc = {};
  for (const g of games) {
    const me = g.analysis[g.color === "w" ? "white" : "black"];
    stats.record[g.outcome ?? "unknown"]++;
    const name = g.analysis.opening?.name.split(":")[0] ?? "Unknown";
    const o = (stats.openings[name] ??= { games: 0, win: 0, loss: 0, draw: 0, accuracy: 0 });
    o.games++;
    if (g.outcome && g.outcome in o) o[g.outcome]++;
    o.accuracy += me.accuracy ?? 0;
    for (const p of g.analysis.plies) {
      if (p.color !== g.color) continue;
      stats.counts[p.cls] = (stats.counts[p.cls] ?? 0) + 1;
      const ph = (phaseAcc[p.phase] ??= { sum: 0, n: 0, errors: 0 });
      ph.sum += p.accuracy;
      ph.n++;
      if (ERRORS.includes(p.cls)) {
        ph.errors++;
        if (p.cls !== "inaccuracy") stats.errorsByPiece[p.piece] = (stats.errorsByPiece[p.piece] ?? 0) + 1;
        for (const t of p.tags) stats.tags[t] = (stats.tags[t] ?? 0) + 1;
      }
    }
  }
  for (const [ph, v] of Object.entries(phaseAcc)) {
    stats.phases[ph] = { accuracy: +(v.sum / v.n).toFixed(1), moves: v.n, errors: v.errors };
  }
  for (const o of Object.values(stats.openings)) o.accuracy = +(o.accuracy / o.games).toFixed(1);
  if (games.length) {
    const rows = games.map(row);
    stats.avgAccuracy = +(rows.reduce((a, t) => a + (t.accuracy ?? 0), 0) / games.length).toFixed(1);
    stats.avgRating = Math.round(rows.reduce((a, t) => a + t.rating, 0) / games.length / 50) * 50;
  }
  return { stats, patterns: patternWindow(everything, last) };
}

export function gameListing() {
  return allGames().map((g) => {
    const me = g.analysis[g.color === "w" ? "white" : "black"];
    const opp = g.analysis[g.color === "w" ? "black" : "white"];
    return {
      id: g.id,
      createdAt: g.createdAt,
      playedAt: g.playedAt ?? null,
      source: g.source ?? null,
      color: g.color,
      outcome: g.outcome,
      opponent: g.color === "w" ? g.players.black : g.players.white,
      opening: g.analysis.opening?.name ?? "Unknown opening",
      moves: Math.ceil(g.analysis.plies.length / 2),
      accuracy: me.accuracy,
      rating: me.rating,
      oppRating: opp.rating,
      headline: g.coach?.headline ?? null,
    };
  });
}

// Which provider/models to use. Models are remembered per provider: { coach, vision }.
// GLM 5.3 writes the coaching; GLM 5.3 Flash reads screenshots (plain GLM 5.3 can't take images).
const DEFAULT_MODELS = {
  anthropic: { coach: "claude-opus-5-5", vision: "claude-opus-5-5" },
  openrouter: { coach: "z-ai/glm-5.3", vision: "z-ai/glm-5.3-flash" },
  nanogpt: { coach: "z-ai/glm-5.3", vision: "z-ai/glm-5.3-flash" },
};

export function loadSettings() {
  const s = readJson(SETTINGS, {});
  const models = {};
  for (const [provider, defaults] of Object.entries(DEFAULT_MODELS)) {
    const saved = s.models?.[provider] ?? {};
    // An empty pick falls back to the default.
    models[provider] = { coach: saved.coach || defaults.coach, vision: saved.vision || defaults.vision };
  }
  return { provider: s.provider ?? null, models };
}

export function saveSettings(settings) {
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
}
