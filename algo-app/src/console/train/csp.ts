/**
 * Module 02's two libraries that draw with inline styles -- CodeMirror and
 * xterm.js -- under the console's CSP, which admits no 'unsafe-inline'.
 *
 * - A <style> element our scripts create gets the page's nonce
 *   (src/algo/server.ts sendShell puts it in <meta name="csp-nonce">).
 * - A style *attribute* our scripts set goes through the CSSOM instead
 *   (el.style.cssText), which CSP allows: xterm.js colours 24-bit text that way.
 *
 * Neither admits anything new to an attacker: both are reachable only by
 * script, and script is already limited to 'self'. Markup injected into the
 * page still cannot carry a style element or attribute.
 */
export function installCspShims(): void {
  const proto = Element.prototype as Element & { __tmCsp?: boolean };
  if (proto.__tmCsp) return;
  proto.__tmCsp = true;

  const nonce = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';
  if (nonce && !nonce.startsWith('{{')) {
    const create = Document.prototype.createElement;
    Document.prototype.createElement = function (this: Document, tag: string, opts?: ElementCreationOptions) {
      const el = create.call(this, tag, opts);
      if (tag.toLowerCase() === 'style') (el as HTMLStyleElement).nonce = nonce;
      return el;
    } as typeof Document.prototype.createElement;
  }

  const setAttribute = proto.setAttribute;
  proto.setAttribute = function (this: Element, name: string, value: string) {
    if (name.toLowerCase() === 'style' && 'style' in this) {
      (this as HTMLElement).style.cssText = String(value);
      return;
    }
    setAttribute.call(this, name, value);
  };
}
