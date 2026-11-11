// Recent games for a chess.com player, from chess.com's free public API (no key needed).
const UA = { "User-Agent": "chess-teacher-local/1.0" };
const API = "https://api.chess.com/pub/player";

export class ChessComError extends Error {}

async function get(url) {
  let res;
  try {
    res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new ChessComError("Couldn't reach chess.com. Check your connection.");
  }
  if (res.status === 404) throw new ChessComError("chess.com has no player with that username.");
  if (res.status === 429) throw new ChessComError("chess.com is rate limiting requests. Try again in a minute.");
  if (!res.ok) throw new ChessComError(`chess.com returned an error (${res.status}).`);
  return res.json();
}

export async function recentGames(username, limit = 25) {
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(username)) throw new ChessComError("That doesn't look like a chess.com username.");
  const user = username.toLowerCase();
  const { archives = [] } = await get(`${API}/${user}/games/archives`);
  const games = [];
  // Newest month first; go back a few months until there are enough games.
  for (const url of archives.slice(-4).reverse()) {
    const month = await get(url);
    const batch = (month.games ?? [])
      .filter((g) => g.rules === "chess" && g.pgn) // standard chess only (no 960 and other variants)
      .sort((a, b) => b.end_time - a.end_time);
    games.push(...batch);
    if (games.length >= limit) break;
  }
  return games.slice(0, limit).map((g) => {
    const color = g.white.username.toLowerCase() === user ? "w" : "b";
    const result = g.white.result === "win" ? "1-0" : g.black.result === "win" ? "0-1" : "1/2-1/2";
    const me = color === "w" ? g.white : g.black;
    const opp = color === "w" ? g.black : g.white;
    return {
      url: g.url,
      endTime: g.end_time * 1000,
      timeClass: g.time_class,
      color,
      result,
      outcome: result === "1/2-1/2" ? "draw" : (result === "1-0") === (color === "w") ? "win" : "loss",
      how: (me.result === "win" ? opp.result : me.result) ?? null, // checkmated, resigned, timeout...
      white: g.white.username,
      black: g.black.username,
      whiteRating: g.white.rating ?? null,
      blackRating: g.black.rating ?? null,
      opening: g.eco ? decodeURIComponent(g.eco.split("/openings/")[1] ?? "").replace(/-/g, " ").replace(/(\.\.\.|\s\d).*$/, "") : null,
      moves: g.pgn.replace(/\[[^\]]*\]/g, "").match(/\b\d+\. /g)?.length ?? 0,
      pgn: g.pgn,
    };
  });
}
