// One interface over several model providers. Anthropic goes through its SDK; OpenRouter and
// NanoGPT speak the OpenAI-style chat completions protocol. Every call asks for a JSON object
// described by a zod schema and validates the reply, so any reasonably capable model works.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export const PROVIDERS = {
  anthropic: { name: "Anthropic", env: "ANTHROPIC_API_KEY" },
  openrouter: { name: "OpenRouter", env: "OPENROUTER_API_KEY", base: "https://openrouter.ai/api/v1", models: "/models" },
  nanogpt: { name: "NanoGPT", env: "NANOGPT_API_KEY", base: "https://nano-gpt.com/api/v1", models: "/models?detailed=true" },
};

export const hasKey = (provider) => !!process.env[PROVIDERS[provider]?.env];

// Used when the Anthropic model list can't be fetched (no key yet).
const ANTHROPIC_FALLBACK = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-fable-5-2", "Claude Fable 5.2"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
].map(([id, name]) => ({ id, name, vision: true, maxOutput: 64000, price: null }));

let anthropic = null;
const anthropicClient = () => (anthropic ??= new Anthropic());

// ------------------------------------------------------------------ errors

export function describeError(err, provider) {
  const p = PROVIDERS[provider];
  const who = p?.name ?? "The model provider";
  const keyHelp = p ? `Put ${p.env} in the .env file and restart.` : "";
  if (err instanceof LlmError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return `Anthropic API key is missing or invalid. ${keyHelp}`;
  if (err instanceof Anthropic.NotFoundError) return "Anthropic doesn't know that model. Pick another one.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic error (${err.status}): ${err.message}`;
  if (/Could not resolve authentication/i.test(err?.message ?? "")) return `No ${who} API key found. ${keyHelp}`;
  if (err?.cause?.code || err?.name === "TypeError") return `Couldn't reach ${who}. Check your connection.`;
  return err?.message ?? String(err);
}

export class LlmError extends Error {}

function httpError(provider, status, body) {
  const p = PROVIDERS[provider];
  const detail = body?.error?.message ?? body?.message ?? (typeof body === "string" ? body.slice(0, 300) : "");
  if (status === 401 || status === 403) return new LlmError(`${p.name} rejected the API key. Check ${p.env} in the .env file.`);
  if (status === 402) return new LlmError(`${p.name}: out of credits. ${detail}`);
  if (status === 404) return new LlmError(`${p.name} doesn't have that model. Pick another one. ${detail}`);
  if (status === 429) return new LlmError(`${p.name} rate limit hit. Try again in a minute. ${detail}`);
  return new LlmError(`${p.name} error (${status}). ${detail}`);
}

// ------------------------------------------------------------------ model lists

const cache = {};
const perMillion = (x) => (x == null || Number.isNaN(Number(x)) ? null : Number(x));

async function fetchModels(provider) {
  const p = PROVIDERS[provider];
  if (provider === "anthropic") {
    if (!hasKey("anthropic")) return ANTHROPIC_FALLBACK;
    const out = [];
    for await (const m of anthropicClient().models.list()) {
      out.push({ id: m.id, name: m.display_name ?? m.id, vision: true, maxOutput: m.max_tokens ?? null, price: null });
    }
    return out;
  }
  const headers = hasKey(provider) ? { Authorization: `Bearer ${process.env[p.env]}` } : {};
  const res = await fetch(p.base + p.models, { headers, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.data)) throw httpError(provider, res.status, body);
  return body.data
    .filter((m) => (m.architecture?.output_modalities ?? ["text"]).includes("text"))
    .map((m) => {
      const inputs = m.architecture?.input_modalities;
      // OpenRouter prices are dollars per token; NanoGPT's are already per million tokens.
      const scale = provider === "openrouter" ? 1e6 : 1;
      const inP = perMillion(m.pricing?.prompt);
      const outP = perMillion(m.pricing?.completion);
      return {
        id: m.id,
        name: m.name ?? m.id,
        vision: inputs ? inputs.includes("image") : m.capabilities?.vision ?? null,
        maxOutput: m.top_provider?.max_completion_tokens ?? m.max_output_tokens ?? null,
        price: inP == null || outP == null ? null : { in: +(inP * scale).toFixed(3), out: +(outP * scale).toFixed(3) },
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listModels(provider) {
  if (!PROVIDERS[provider]) throw new LlmError("Unknown provider.");
  const hit = cache[provider];
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.models;
  const models = await fetchModels(provider);
  cache[provider] = { at: Date.now(), models };
  return models;
}

// ------------------------------------------------------------------ chat

// messages: [{ role: "user" | "assistant", text, images?: [{ mediaType, data }] }]
async function chatAnthropic({ model, system, messages, maxTokens }) {
  const stream = anthropicClient().messages.stream({
    model,
    max_tokens: maxTokens,
    system,
    messages: messages.map((m) => ({
      role: m.role,
      content: [
        ...(m.images ?? []).map((img) => ({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } })),
        { type: "text", text: m.text },
      ],
    })),
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new LlmError("The model declined this request.");
  if (message.stop_reason === "max_tokens") throw new LlmError("The model's reply was cut off before it finished. Try a model with a larger output limit.");
  return message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

async function chatOpenAI({ provider, model, system, messages, maxTokens }) {
  const p = PROVIDERS[provider];
  const res = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env[p.env]}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true, // long reviews would otherwise hit HTTP timeouts
      messages: [
        { role: "system", content: system },
        ...messages.map((m) => ({
          role: m.role,
          content: m.images?.length
            ? [{ type: "text", text: m.text }, ...m.images.map((img) => ({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } }))]
            : m.text,
        })),
      ],
    }),
  });
  if (!res.ok) {
    const raw = await res.text();
    let body = raw;
    try {
      body = JSON.parse(raw);
    } catch {}
    throw httpError(provider, res.status, body);
  }
  let text = "";
  let finish = null;
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue; // blank lines, SSE comments / keep-alives
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      if (ev.error) throw new LlmError(`${p.name}: ${ev.error.message ?? "the model returned an error"}`);
      const choice = ev.choices?.[0];
      if (typeof choice?.delta?.content === "string") text += choice.delta.content;
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  }
  if (finish === "length") throw new LlmError("The model's reply was cut off before it finished. Try a model with a larger output limit.");
  if (finish === "content_filter") throw new LlmError("The model declined this request.");
  if (!text.trim()) throw new LlmError("The model returned an empty reply. Try a different model.");
  return text;
}

function parseJsonReply(text) {
  const body = text.replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in the reply.");
  return JSON.parse(body.slice(start, end + 1));
}

// Ask for a JSON object matching `schema`. Returns { data, raw } (raw = the model's text, for continuing the conversation).
export async function completeJson({ provider, model, system, messages, schema, maxTokens = 16000 }) {
  if (!PROVIDERS[provider]) throw new LlmError("Pick a model provider first.");
  if (!model) throw new LlmError("Pick a model first.");
  if (!hasKey(provider)) throw new LlmError(`No ${PROVIDERS[provider].name} API key found. Put ${PROVIDERS[provider].env} in the .env file and restart.`);

  const info = (await listModels(provider).catch(() => [])).find((m) => m.id === model);
  if (info?.vision === false && messages.some((m) => m.images?.length)) {
    throw new LlmError(`${info.name} can't read images. Pick a vision-capable model for reading screenshots.`);
  }
  if (info?.maxOutput) maxTokens = Math.min(maxTokens, info.maxOutput);

  const fullSystem = `${system}\n\nReply with a single JSON object and nothing else: no prose before or after it, no code fences. It must validate against this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}`;
  const chat = provider === "anthropic" ? chatAnthropic : chatOpenAI;
  const convo = [...messages];
  for (let attempt = 0; ; attempt++) {
    const raw = await chat({ provider, model, system: fullSystem, messages: convo, maxTokens });
    try {
      return { data: schema.parse(parseJsonReply(raw)), raw };
    } catch (err) {
      if (attempt >= 1) throw new LlmError("The model didn't return the review in the expected format. Try again or pick a stronger model.");
      const why = err instanceof z.ZodError ? z.prettifyError(err) : err.message;
      convo.push({ role: "assistant", text: raw }, { role: "user", text: `That reply couldn't be used: ${why}\nSend the complete JSON object again, corrected, and nothing else.` });
    }
  }
}
