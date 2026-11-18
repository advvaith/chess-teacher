// The "played like" rating: how strong one side's moves looked in one game.
//
// One game says little about a player. Among players rated about 500 the accuracy of a single game runs from
// the low 50s to the mid 90s, as wide as the gap between a beginner and a master on average. So the figure
// starts from the player's real rating when it is known and moves only part of the way toward what the
// accuracy alone would suggest, further for long games than short ones.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Typical accuracy of a game -> rating. The 77% = 500 point is measured (the median of 140 chess.com players
// rated 430-590 in reviewed games); the rest of the curve is an estimate.
const CURVE = [
  [40, 100], [60, 250], [70, 380], [77, 500], [82, 750], [86, 1050], [89, 1350],
  [91.5, 1650], [93.5, 1950], [95, 2250], [96.5, 2550], [98, 2850], [99.2, 3200],
];
// With no real rating to start from, assume an average online player.
const UNKNOWN = 800;
export const RATING_VERSION = 2;

function fromAccuracy(acc) {
  if (acc <= CURVE[0][0]) return CURVE[0][1];
  for (let i = 1; i < CURVE.length; i++) {
    const [a1, r1] = CURVE[i];
    const [a0, r0] = CURVE[i - 1];
    if (acc <= a1) return r0 + ((acc - a0) / (a1 - a0)) * (r1 - r0);
  }
  return CURVE.at(-1)[1];
}

export function gameAccuracy(accs) {
  if (!accs.length) return null;
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const harmonic = accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 1), 0);
  return (mean + harmonic) / 2;
}

// accuracy: over the moves the player had to find (not book). moves: how many of those there were.
// actual: the player's real rating, if known.
export function estimateRating(accuracy, moves, actual) {
  if (accuracy == null) return { rating: actual ?? UNKNOWN, confidence: "very rough" };
  const raw = fromAccuracy(accuracy);
  // How far to move from the starting point toward the accuracy figure. A known rating is a strong starting
  // point (at most 45% of the way, for a long game); a guess is a weak one.
  const weight = actual ? Math.min(0.45, moves / (moves + 60)) : moves / (moves + 15);
  const rating = (actual ?? UNKNOWN) + weight * (raw - (actual ?? UNKNOWN));
  return {
    rating: Math.round(clamp(rating, 100, 3200) / 50) * 50,
    confidence: moves >= 25 ? "decent" : moves >= 12 ? "rough" : "very rough",
  };
}

// Bring a saved game's two estimates up to date (older reviews used a far more generous curve and ignored the
// real ratings). Returns true if anything changed.
export function rerate(game) {
  const a = game?.analysis;
  if (!a || a.ratingVersion === RATING_VERSION) return false;
  for (const [side, color] of [["white", "w"], ["black", "b"]]) {
    const mine = a.plies.filter((p) => p.color === color);
    const judged = mine.filter((p) => p.cls !== "book");
    const acc = gameAccuracy((judged.length ? judged : mine).map((p) => p.accuracy));
    Object.assign(a[side], estimateRating(acc, judged.length, game.ratings?.[side] ?? null));
  }
  a.ratingVersion = RATING_VERSION;
  return true;
}
