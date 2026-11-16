// Thin UCI wrapper around Stockfish. Uses a native binary if STOCKFISH_PATH is set,
// otherwise the WASM build that ships with the `stockfish` npm package.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import readline from "node:readline";

const require = createRequire(import.meta.url);

function engineCommand() {
  if (process.env.STOCKFISH_PATH) return [process.env.STOCKFISH_PATH, []];
  const findEngine = require("stockfish/scripts/findEngine.js");
  return [process.execPath, [findEngine(process.env.STOCKFISH_FLAVOR || "lite-single")]];
}

class Engine {
  constructor() {
    const [cmd, args] = engineCommand();
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] });
    this.waiters = [];
    this.onLine = null;
    this.dead = null;
    this.proc.on("error", (e) => this.fail(e));
    this.proc.on("exit", () => this.fail(new Error("Stockfish exited unexpectedly")));
    readline.createInterface({ input: this.proc.stdout }).on("line", (line) => {
      this.onLine?.(line);
      this.waiters = this.waiters.filter((w) => {
        if (!w.test(line)) return true;
        w.resolve(line);
        return false;
      });
    });
  }

  fail(err) {
    if (this.quitting) return;
    this.dead = err;
    for (const w of this.waiters) w.reject(err);
    this.waiters = [];
  }

  send(cmd) {
    if (this.dead) throw this.dead;
    this.proc.stdin.write(cmd + "\n");
  }

  waitFor(test) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => this.waiters.push({ test, resolve, reject }));
  }

  async init() {
    const ok = this.waitFor((l) => l === "uciok");
    this.send("uci");
    await ok;
    this.send("setoption name MultiPV value 2");
    this.send("setoption name Hash value 64");
    const ready = this.waitFor((l) => l === "readyok");
    this.send("isready");
    await ready;
  }

  // Returns up to 2 lines, scores from the side-to-move's point of view.
  async analyse(fen, { depth, movetime }) {
    const lines = [];
    this.onLine = (line) => {
      if (!line.startsWith("info ") || !line.includes(" pv ")) return;
      const m = line.match(/ multipv (\d+) .*?score (cp|mate) (-?\d+)(?: (upperbound|lowerbound))?.* pv (.+)$/);
      if (!m) return;
      const idx = Number(m[1]) - 1;
      // Keep bounded scores only if we have nothing better for this line yet.
      if (m[4] && lines[idx]) return;
      const d = Number(line.match(/ depth (\d+)/)?.[1] ?? 0);
      lines[idx] = { depth: d, [m[2]]: Number(m[3]), pv: m[5].trim().split(/\s+/) };
    };
    const done = this.waitFor((l) => l.startsWith("bestmove"));
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth} movetime ${movetime}`);
    await done;
    this.onLine = null;
    return lines.filter(Boolean);
  }

  quit() {
    this.quitting = true;
    try {
      this.proc.stdin.write("quit\n");
    } catch {}
    setTimeout(() => this.proc.kill(), 500).unref();
  }
}

// Evaluate many positions with a small pool of engine processes.
export async function evaluatePositions(fens, { depth = 16, movetime = 2500, onProgress } = {}) {
  const workers = Math.max(1, Math.min(4, os.cpus().length - 2, fens.length));
  const engines = await Promise.all(
    Array.from({ length: workers }, async () => {
      const e = new Engine();
      await e.init();
      return e;
    }),
  );
  const results = new Array(fens.length);
  let next = 0;
  let finished = 0;
  try {
    await Promise.all(
      engines.map(async (engine) => {
        while (next < fens.length) {
          const i = next++;
          results[i] = fens[i] ? await engine.analyse(fens[i], { depth, movetime }) : [];
          onProgress?.(++finished, fens.length);
        }
      }),
    );
  } finally {
    for (const e of engines) e.quit();
  }
  return results;
}

// One position, for trying out moves on the board. A single engine is kept warm and shut down when idle.
let solo = null;
let soloIdle = null;
let soloQueue = Promise.resolve();
export function evaluateOne(fen, { depth = 16, movetime = 1500 } = {}) {
  const run = async () => {
    clearTimeout(soloIdle);
    if (!solo || solo.dead) {
      solo = new Engine();
      await solo.init();
    }
    try {
      return await solo.analyse(fen, { depth, movetime });
    } finally {
      soloIdle = setTimeout(() => {
        solo?.quit();
        solo = null;
      }, 120000);
      soloIdle.unref();
    }
  };
  const result = soloQueue.then(run, run);
  soloQueue = result.catch(() => {});
  return result;
}
