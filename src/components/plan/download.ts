// Browser-only save, copy and print for the Plan exports. The documents themselves come from the DOM-free
// src/services/screenplay.ts and shots.ts, which the MCP also uses.

/** A name safe for a download (as DeliverWorkspace does). */
export const safeFileName = (name: string) => (name.trim() || 'Untitled').replace(/[^a-zA-Z0-9_-]+/g, '_');

/** Saves `data` from the browser: these files are a few kilobytes, so no server round trip. */
export function downloadFile(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type })), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Copies formatted text (Google Docs, Word, Sheets keep the layout) with a plain-text twin. True when it worked. */
export async function copyRich(html: string, text: string) {
  try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); return true; }
  catch { /* the clipboard API needs a secure context; a plain-HTTP LAN address still copies a selection */ }
  // `html` comes from the serializers, which escape every user string.
  const box = document.createElement('div'), selection = getSelection(), range = document.createRange();
  box.contentEditable = 'true'; box.innerHTML = html; Object.assign(box.style, { position: 'fixed', left: '-10000px', top: '0' });
  document.body.append(box); range.selectNodeContents(box); selection?.removeAllRanges(); selection?.addRange(range);
  try { return document.execCommand('copy'); } catch { return false; } finally { selection?.removeAllRanges(); box.remove(); }
}

/** Opens the print dialog (Save as PDF) for a full HTML document, from a hidden frame so the editor stays put. */
export function printHtml(html: string) {
  const frame = document.createElement('iframe'), done = () => frame.remove();
  Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  frame.onload = () => { const view = frame.contentWindow; if (!view) return done(); view.addEventListener('afterprint', done); setTimeout(done, 60_000); view.focus(); view.print(); };
  frame.srcdoc = html; document.body.append(frame);
}
