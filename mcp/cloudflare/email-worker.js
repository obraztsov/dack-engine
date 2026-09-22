/**
 * Cloudflare Email Worker — the EXTERNAL half of the dack email channel (deploy on the duck's domain via
 * Cloudflare Email Routing → "Send to a Worker"). Cloudflare hands each inbound email to `email()`; this
 * parses it (text + attachments) and POSTs a normalized JSON body to the duck's `email-ingress` module,
 * authenticated with a shared secret.
 *
 * Setup:
 *   1. Cloudflare dashboard → your domain → Email → Email Routing → enable; add a custom address (e.g.
 *      hello@yourduck.tld) routed to THIS worker.
 *   2. `npm i postal-mime` and bundle (wrangler). Set Worker vars/secrets:
 *        EMAIL_INGRESS_URL    = https://<publicly-exposed email-ingress>/   (pond proxy / tunnel → the module)
 *        EMAIL_INGRESS_SECRET = <same value as the module's EMAIL_INGRESS_SECRET>
 *   3. The email-ingress module must be reachable from Cloudflare (behind the pond proxy or a tunnel).
 *
 * Outbound email is NOT this Worker (Email Workers can only reply/forward) — the duck sends via the
 * transactional API configured in `email-send-mcp.ts` (Resend/Postmark/…). Inbound-only here.
 */
import PostalMime from 'postal-mime'

/** base64 of an ArrayBuffer, chunked so a large attachment can't blow the call stack (no Buffer in Workers). */
function toBase64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

export default {
  async email(message, env, _ctx) {
    const email = await new PostalMime().parse(await new Response(message.raw).arrayBuffer())
    const attachments = (email.attachments || []).map((a) => ({
      filename: a.filename || 'file',
      mime: a.mimeType || 'application/octet-stream',
      content: toBase64(a.content),
    }))
    const body = {
      from: message.from,
      subject: email.subject || '',
      text: email.text || email.html || '',
      message_id: email.messageId || message.headers.get('message-id') || '',
      attachments,
    }
    const r = await fetch(env.EMAIL_INGRESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Email-Ingress-Secret': env.EMAIL_INGRESS_SECRET },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`email-ingress ${r.status}`) // Cloudflare retries on throw
  },
}
