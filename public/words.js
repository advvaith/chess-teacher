// Chess notation -> plain words, for players who don't read notation fluently.
// Used by the server (to clean up the coach's prose) and by the page.
const PIECE = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" };
const suffix = (promo, mark) =>
  (promo ? `, promoting to a ${PIECE[promo[1]]}` : "") + (mark === "#" ? ", checkmate" : mark === "+" ? " with check" : "");

// One known move in standard notation, e.g. "Nxd5+" -> "knight takes on d5 with check".
export function describeMove(san) {
  const s = san.replace(/[!?]+$/, "");
  if (/^(O-O-O|0-0-0)/.test(s)) return "castling queenside" + suffix(null, s.at(-1));
  if (/^(O-O|0-0)/.test(s)) return "castling kingside" + suffix(null, s.at(-1));
  const m = s.match(/^([KQRBN])?([a-h]?[1-8]?)(x?)([a-h][1-8])(=[QRBN])?([+#])?$/);
  if (!m) return san;
  const [, piece, , takes, to, promo, mark] = m;
  return `${piece ? PIECE[piece] : "pawn"} ${takes ? "takes on" : "to"} ${to}${suffix(promo, mark)}`;
}

// Free text: rewrite any notation the writer slipped in. Bare pawn moves like "e4" are left alone,
// because they read the same as the name of the square.
export function plainMoves(text) {
  if (!text) return text;
  const MOVE = /(\d+\s?\.(?:\s?\.\.)?\s*|\.\.\.\s*|…\s*)?(?<![A-Za-z0-9])(O-O-O|0-0-0|O-O|0-0|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8](?:=[QRBN])?[+#]?|[a-h][18]=[QRBN][+#]?|[a-h][1-8][+#])(?![A-Za-z0-9])/g;
  return text.replace(MOVE, (whole, prefix, san, offset) => {
    const words = describeMove(san);
    if (words === san) return whole;
    const before = text.slice(0, offset).trimEnd();
    const startsSentence = !before || /[.!?:]$/.test(before);
    return startsSentence ? words[0].toUpperCase() + words.slice(1) : words;
  });
}
