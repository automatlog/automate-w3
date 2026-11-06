/**
 * The AI step on 0G (6 Nov 2026, ETHGlobal) — the 0G Compute Router, an
 * OpenAI-compatible endpoint whose answers come from providers on 0G's compute
 * network. Every answer carries `x_0g_trace.request_id` (docs: compute-network
 * /router/features/chat-completions); the step keeps it, and it goes into the
 * run's record on 0G, so a sealed run says which 0G request produced its AI
 * output.
 *
 * Same shape as ai-server's chat() — { system, text, jsonMode, temperature,
 * maxTokens } → text — so aiStep() takes it as its chatFn, plus `last` for the
 * request id of the call just made.
 */
const BASE = () => String(process.env.ZG_ROUTER_URL || 'https://router-api.0g.ai/v1').replace(/\/+$/, '')
/** A Router call waits this long. */
const TIMEOUT_MS = 60_000

export const zgRouterConfig = () => {
  const key = String(process.env.ZG_ROUTER_KEY || '').trim()
  return { ready: Boolean(key), missing: key ? [] : ['ZG_ROUTER_KEY'], model: process.env.ZG_ROUTER_MODEL || 'glm-5.2', base: BASE() }
}

/** Make a chat function for one AI step; `fn.last` holds { requestId, model, provider } after a call. */
export function zgChat({ fetchImpl } = {}) {
  const fn = async ({ system, text, jsonMode = false, temperature = 0.2, maxTokens = 400 }) => {
    const cfg = zgRouterConfig()
    if (!cfg.ready) throw new Error('the 0G Router is not set up on this server (ZG_ROUTER_KEY)')
    const res = await (fetchImpl || fetch)(`${cfg.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(process.env.ZG_ROUTER_KEY).trim()}` },
      body: JSON.stringify({
        model: cfg.model, temperature, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: String(text || '') }],
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) throw new Error(`the 0G Router answered HTTP ${res.status}${body?.error?.message ? ` — ${String(body.error.message).slice(0, 160)}` : ''}`)
    fn.last = { requestId: body?.x_0g_trace?.request_id || body?.id || null, model: body?.model || cfg.model, provider: '0g-router' }
    return String(body?.choices?.[0]?.message?.content || '')
  }
  fn.last = null
  return fn
}
