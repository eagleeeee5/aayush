// Vercel serverless function: bridges your page to the Anthropic API.
// The secret key is read from the environment variable ANTHROPIC_API_KEY.
// Optional: set CLAUDE_MODEL in Vercel to change the model (default: Haiku 4.5, the cheapest).
module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not set in Vercel." });
    return;
  }
 
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const message = String(body.message || "").slice(0, 4000);
  let context = body.context || "";
  if (typeof context !== "string") context = JSON.stringify(context);
  context = context.slice(0, 12000); // keep input tokens (cost) small
  if (!message) {
    res.status(400).json({ error: "Empty message." });
    return;
  }
 
  // Build the conversation: earlier turns (from the page) + the new question.
  const msgs = [];
  const history = Array.isArray(body.history) ? body.history.slice(-8) : [];
  for (const h of history) {
    const role = h && h.role === "assistant" ? "assistant" : h && h.role === "user" ? "user" : null;
    const text = h && typeof h.text === "string" ? h.text.slice(0, 2000).trim() : "";
    if (!role || !text) continue;
    if (msgs.length && msgs[msgs.length - 1].role === role) msgs[msgs.length - 1].content += "\n" + text;
    else msgs.push({ role, content: text });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift(); // must start with a user turn
  if (msgs.length && msgs[msgs.length - 1].role === "user") msgs[msgs.length - 1].content += "\n" + message;
  else msgs.push({ role: "user", content: message });
 
  const model = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
  const system =
    "You are a friendly tutor for BET402 Design of Timber Structures " +
    "(Australian Standards, e.g. AS 1720.1). Explain step by step and show " +
    "formulas and units. If unsure, say so and suggest checking the standard.\n\n" +
    "Page context:\n" + context;
 
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");
 
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 1000, // cap on reply length (cost safety)
        stream: true,
        system,
        messages: msgs
      })
    });
 
    if (!r.ok || !r.body) {
      const t = await r.text().catch(() => "");
      send({ type: "error", error: "Anthropic error " + r.status + ": " + t.slice(0, 300) });
      res.end();
      return;
    }
 
    send({ type: "meta" });
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
          send({ type: "delta", delta: ev.delta.text });
        } else if (ev.type === "error") {
          send({ type: "error", error: (ev.error && ev.error.message) || "Stream error" });
        }
      }
    }
    send({ type: "done", sources: [] });
  } catch (e) {
    send({ type: "error", error: String(e.message || e) });
  }
  res.end();
};
 
