# Chess Teacher

A self-hosted game reviewer for chess.com players. Pull in your recent games, and get an engine review of each one plus a coach that explains your moves in plain words and keeps track of the habits that show up across your games.

It runs on your own machine. Stockfish does the analysis locally; the written coaching is optional and uses whichever model provider you have a key for.

## What it does

- **Import from chess.com.** Type your username and pick from your recent games, or tick several and review them as a batch. You can also paste a PGN or drop in a screenshot of a move list.
- **Engine review.** Every position is evaluated by Stockfish. You get an eval bar, an eval graph, and a label on every move: book, forced, brilliant, great, best, excellent, good, inaccuracy, mistake, miss or blunder.
- **Try your own moves.** In the walkthrough, click a piece and play any move from any point in the game. The engine shows the best move for the side to play and the best reply to it, so you can test what would have happened.
- **"Played like" ratings.** An accuracy score and a rough rating estimate for both players, overall and by phase of the game, shown next to the real ratings.
- **Opening name**, from the Lichess opening tables, with the theory moves marked as book.
- **Walkthrough comments, no model needed.** Every move gets a comment written by code from the engine's analysis and the rules of chess: hanging pieces, free captures, forks, pins, skewers, discovered attacks and double checks, trapped pieces, removing a defender, mate threats, missed and allowed forced mates, back-rank mates, stalemate, sacrifices, forced moves, plus development, castling and passed pawns. Moves are written in words ("knight from f6 takes the pawn on e4"), not notation.
- **Game summary (optional).** A language model writes the story of the game, the turning points and what to work on.
- **Pattern tracking.** The coach names recurring habits, strengths and weaknesses, and the same habit is tracked from game to game. A profile page shows them for your recent games only (the last 10 by default, or 5, 20 or all), so a habit you fix drops off after a few clean games, and marks whether each one is showing up more or less than before. It also has accuracy by phase, how your errors happen, and your results by opening.

Without an API key everything except the written coaching and screenshot reading still works.

## Quick start

Needs Node.js 22 or newer.

```bash
git clone https://github.com/advvaith/chess-teacher.git
cd chess-teacher
npm install
cp .env.example .env    # then add a key for the provider you use
npm start
```

Open http://localhost:3000.

### Model providers

Add one or more of these to `.env`:

| Variable | Provider |
|---|---|
| `NANOGPT_API_KEY` | [NanoGPT](https://nano-gpt.com) |
| `OPENROUTER_API_KEY` | [OpenRouter](https://openrouter.ai) |
| `ANTHROPIC_API_KEY` | [Anthropic](https://console.anthropic.com) |

Pick the provider and models on the home page. There are two picks: a coach model, and a vision-capable model that is only used to read screenshots. The defaults on NanoGPT and OpenRouter are GLM 5.3 for coaching and GLM 5.3 Flash for screenshots; on Anthropic, Claude Opus 5.5 for both.

### Docker

```bash
docker build -t chess-teacher .
docker run -d --name chess-teacher -p 127.0.0.1:3000:3000 \
  --env-file .env -v "$PWD/data:/app/data" chess-teacher
```

Reviews, patterns and settings live in `data/`, so mount it to keep them.

## Keep it private

There is no login. Anyone who can reach the app can read and delete your reviews and spend your API credits. Run it on localhost, or behind a VPN or your own authentication. Do not put it on the open internet as it is.

## How it works, and what to trust

- The evaluations, move labels, accuracy, opening names and every move-by-move comment come from Stockfish and plain code. No language model is involved in those.
- The "played like" rating starts from the player's real rating when it is known (chess.com imports) and moves part of the way toward what the game's accuracy suggests, further for long games. One game is a very noisy sample, so a 500-rated player's best game reads around 1500, not 2600. The accuracy-to-rating curve is measured around 500 and estimated elsewhere, so treat it as a rough guide. Without a real rating it leans on the accuracy alone.
- The model only writes the game summary, turning points and habits. It is given the move comments and exact board facts (where every piece stands, what attacks what), and its text is checked against the board, with one correction pass. Language models are not strong chess players, so the summary can still occasionally describe an idea loosely. When it and the walkthrough disagree, believe the walkthrough.
- Screenshot reading is checked by replaying the moves on a board: an illegal move is sent back to the model to re-read, and shown to you if it still can't be fixed.

Layout: `server.js` (Express API), `lib/` (engine, analysis, chess.com import, coach, provider layer, storage), `public/` (the page, plain HTML/CSS/JS with no build step).

## Credits and licenses

- This project's code is MIT licensed; see [LICENSE](LICENSE).
- [Stockfish](https://stockfishchess.org), through the [stockfish.js](https://github.com/nmrugg/stockfish.js) npm package, is GPLv3. It is installed as a dependency and run as a separate process; it is not part of this repository.
- Opening names come from [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0), included under `data/openings/`.
- Move handling uses [chess.js](https://github.com/jhlywa/chess.js).

Not affiliated with chess.com. Games are fetched through chess.com's public API.
