/** Immutable sheets shared by source, canvas and thumbnails. A new HMR style
 * revision cannot mutate any previously published snapshot. */
const cache = new WeakMap<Element, { text: string; sheet: CSSStyleSheet }>();
const external = new Map<string, Promise<string>>();
export async function slideSheets(): Promise<CSSStyleSheet[]> {
  return Promise.all(Array.from(document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style:not([data-imslide-shell]),link[rel="stylesheet"]'), async owner => {
    let css:string;
    try {
      if(!owner.sheet)throw new Error('Stylesheet not ready');
      css=Array.from(owner.sheet.cssRules,rule=>rule.cssText).join('\n');
    } catch(error) {
      if(!(owner instanceof HTMLLinkElement))throw error;
      const url=owner.href;
      if(!external.has(url))external.set(url,fetch(url,{signal:AbortSignal.timeout(15000)}).then(response=>{if(!response.ok)throw new Error('页面样式加载失败');return response.text();}).catch(error=>{external.delete(url);throw error;}));
      css=await external.get(url)!;
    }
    const text=css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g,(whole,_quote,url:string)=>url.startsWith('data:') || url.startsWith('#') ? whole : `url(${JSON.stringify(new URL(url,owner instanceof HTMLLinkElement ? owner.href : location.href).href)})`).replace(/:root\b/g,':host');
    const existing=cache.get(owner);if(existing?.text===text)return existing.sheet;
    const sheet=new CSSStyleSheet();sheet.replaceSync(text);cache.set(owner,{text,sheet});return sheet;
  }));
}
let reset:CSSStyleSheet|undefined;
export function slideReset(){
  if(!reset){reset=new CSSStyleSheet();reset.replaceSync(':host{display:block;contain:layout paint;overflow:hidden;background:white;color:#1f2937;font-size:16px;line-height:1.5;font-family:var(--slidev-font-sans, sans-serif)}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}.snapshot-viewport{position:absolute;left:0;top:0;transform-origin:top left;overflow:hidden;background:white}.slidev-page{position:absolute;inset:0}');}
  return reset;
}
