import { defineRootSetup } from '@slidev/types';
import { configs, disableBuiltinSync, useNav } from '@slidev/client';
import { renderFailure } from '../../src/render-error';
import { getCurrentInstance, nextTick, onMounted, onUnmounted, watch } from 'vue';

/** Slidev is an offscreen renderer. The editor displays complete, isolated page documents. */
export default defineRootSetup(() => {
  if (window.parent === window || !location.search.includes('embedded')) return;
  const parent = new URLSearchParams(location.search).get('imslideParent') || document.referrer;
  if (!parent) return;
  const parentOrigin = new URL(parent).origin;
  const nav = useNav();
  disableBuiltinSync();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;
  let requestedRevision = -1;
  let publishedRevision = -1;
  let blocked = false;
  let waitingSince = 0;
  const publishedKeys = new Map<string, string>();
  const app = getCurrentInstance()?.appContext.app;
  const previousHandler = app?.config.errorHandler;
  function fail(error: unknown) {
    if (disposed || blocked) return;
    blocked = true; generation++; clearTimeout(timer); timer = undefined;
    window.parent.postMessage({ type: 'imslide:render-error', error: renderFailure(error, { stage: 'renderer', revision: requestedRevision }) }, parentOrigin);
  }
  if (app) app.config.errorHandler = (error, instance, info) => { fail(error); previousHandler?.(error, instance, info); };
  const runtimeError = (event: ErrorEvent) => fail(event.error || event.message);
  const rejection = (event: PromiseRejectionEvent) => fail(event.reason);
  window.addEventListener('error', runtimeError);
  window.addEventListener('unhandledrejection', rejection);
  async function bounded<T>(task: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([task, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('后台页面渲染超时')), 20000); })]); }
    finally { clearTimeout(timeout); }
  }
  const revision = (_meta: Record<string, unknown>) => Number((configs as { imslide?: { revision?: number } }).imslide?.revision ?? _meta.imslideRevision ?? 0);
  const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  function schedule() {
    if (disposed || blocked) return;
    generation++;
    // Schedule once; a stream of HMR events must not keep postponing the deadline.
    if (!timer) timer = setTimeout(() => { timer = undefined; void publish(); }, 80);
  }
  async function publish() {
    const version = generation;
    const allRoutes = [...nav.slides.value];
    const { imslide: _state, ...visualConfig } = configs as typeof configs & { imslide?: unknown };
    const configKey = JSON.stringify(visualConfig);
    const keyOf = (route: (typeof allRoutes)[number]) => JSON.stringify([
      route.no, route.meta.slide?.frontmatter.imslideContentKey ?? route.meta.slide?.content,
      route.meta.slide?.frontmatter.layout, configKey,
    ]);
    const routes = allRoutes.filter(route => publishedKeys.get(String(route.meta.slide?.frontmatter.imslideId)) !== keyOf(route));
    const contentRevision = revision({});
    const order = allRoutes.map(route => String(route.meta.slide?.frontmatter.imslideId));
    const valid = () => !disposed && !blocked && generation === version;
    try {
      if (contentRevision < requestedRevision) return;
      if (!routes.length) {
        if (!valid()) return;
        publishedRevision = contentRevision;
        window.parent.postMessage({ type: 'imslide:pages', pages: [], order, revision: contentRevision }, parentOrigin);
        return;
      }
      await bounded(Promise.all(routes.map(async route => {
        // Slidev's loader catches import errors and returns its error component.
        // Reject that fallback instead of publishing it as a successful slide.
        const module = await route.load();
        if (!module || typeof module !== 'object' || !('default' in module)) throw new Error(`第 ${route.no} 页模块加载失败`);
        route.meta.__preloaded = true;
        // Resolving the wrapper as well as its module prevents SlideLoading being captured.
        const component = route.component as unknown as { __asyncLoader?: () => Promise<unknown> };
        if (component.__asyncLoader) await component.__asyncLoader();
        else await route.load();
      })));
      await nextTick(); await paint();
      if (!valid()) return;
      const container = document.querySelector<HTMLElement>('#slide-container');
      const content = container?.querySelector<HTMLElement>('#slide-content');
      if (!container || !content) throw new Error('后台页面结构不完整');
      if (document.querySelector('vite-error-overlay')) throw new Error('幻灯片编译失败');
      // HMR can publish metadata before Vue has mounted the new page. Retry the
      // actual readiness condition, rather than padding every update by 450ms.
      if (routes.some(route => {
        const page = container.querySelector(`[data-slidev-no="${route.no}"]`);
        return !page || page.querySelector('.slidev-slide-loading');
      })) {
        waitingSince ||= performance.now();
        if (performance.now() - waitingSince > 20000) throw new Error('页面渲染就绪超时');
        schedule(); return;
      }
      // Resource readiness is checked once, in the replacement iframe, per changed page.
      const width = parseFloat(content.style.width) || 980;
      const height = parseFloat(content.style.height) || 552;
      // Copy stylesheet contents so a later HMR cannot mutate an already displayed page.
      const styles = Array.from(document.styleSheets, sheet => {
        try {
          const css = Array.from(sheet.cssRules, rule => rule.cssText).join('\n');
          const absolute = css.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (whole, _quote, url) => url.startsWith('data:') || url.startsWith('#') ? whole : `url(${JSON.stringify(new URL(url, sheet.href || location.href).href)})`);
          return `<style>${absolute.replace(/<\/style/gi, '<\\/style')}</style>`;
        } catch { return sheet.ownerNode instanceof Element ? sheet.ownerNode.outerHTML : ''; }
      }).join('\n');
      const pages = routes.map(route => {
        const meta = route.meta.slide?.frontmatter || {};
        const clone = container.cloneNode(false) as HTMLElement;
        const clonedFrame = content.cloneNode(false) as HTMLElement;
        const slideshow = document.createElement('div'); slideshow.id = 'slideshow';
        const sourcePage = container.querySelector<HTMLElement>(`[data-slidev-no="${route.no}"]`);
        if (!sourcePage) throw new Error('Slide DOM is not ready');
        slideshow.append(sourcePage.cloneNode(true)); clonedFrame.append(slideshow); clone.append(clonedFrame);
        // Remove playback chrome and captured viewport scale, retaining slide styling.
        clone.style.background = 'white';
        const clonedContent = clone.querySelector<HTMLElement>('#slide-content');
        clonedContent?.style.removeProperty('--slidev-slide-scale');
        for (const child of Array.from(clone.children)) {
          if (child !== clonedContent) child.remove();
        }
        clone.querySelectorAll<HTMLElement>('[data-slidev-no]').forEach(element => {
          if (element.dataset.slidevNo !== String(route.no)) element.remove();
          else { element.style.display = 'block'; element.style.opacity = '1'; element.style.visibility = 'visible'; }
        });
        if (!clone.querySelector(`[data-slidev-no="${route.no}"]`)) throw new Error('Slide DOM is not ready');
        if (clone.querySelector('.slidev-slide-loading')) throw new Error(`第 ${route.no} 页尚未完成渲染`);
        clone.querySelectorAll('img').forEach(image => { image.loading = 'eager'; });
        clone.querySelectorAll('script,iframe,object,embed').forEach(element => element.remove());
        const html = `<!doctype html><html class="${document.documentElement.className}" style="${document.documentElement.style.cssText.replace(/"/g, '&quot;')}"><head><base href="${location.origin}/"><meta charset="utf-8">${styles}<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}#slide-container{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;background:white!important}*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style></head><body class="${document.body.className}">${clone.outerHTML}</body></html>`;
        return { snapshot: crypto.randomUUID(), pageId: meta.imslideId, revision: revision(meta), page: route.no, total: allRoutes.length, width, height, html };
      });
      if (!valid() || pages.some(page => page.revision < requestedRevision)) return;
      for (const route of routes) publishedKeys.set(String(route.meta.slide?.frontmatter.imslideId), keyOf(route));
      for (const id of publishedKeys.keys()) if (!order.includes(id)) publishedKeys.delete(id);
      publishedRevision = contentRevision;
      waitingSince = 0;
      window.parent.postMessage({ type: 'imslide:pages', pages, order, revision: contentRevision }, parentOrigin);
    } catch (error) {
      // A failed replacement never removes the last complete visible document.
      if (valid()) fail(error);
    }
  }
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.type !== 'imslide:navigate') return;
    const next = event.data.revision;
    if (!Number.isInteger(next) || next <= requestedRevision) return;
    requestedRevision = next; blocked = false; waitingSince = 0;
    if (next > publishedRevision) schedule();
  };
  window.addEventListener('message', receive);
  const unwatch = watch(() => nav.slides.value.map(route => [route.no, route.meta.slide?.frontmatter.imslideId, revision(route.meta.slide?.frontmatter || {})]), schedule, { deep: true, flush: 'post', immediate: true });
  const observer = new MutationObserver(schedule);
  onMounted(() => {
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    const container = document.querySelector('#slideshow');
    if (container) observer.observe(container, { childList: true, subtree: true, characterData: true });
    schedule();
  });
  const afterUpdate = (payload: { updates?: Array<{ path: string; acceptedPath?: string }> }) => {
    // A module can finish HMR after its frontmatter has already changed.
    // Invalidate that page again rather than retaining an earlier DOM snapshot.
    for (const update of payload.updates || []) {
      const match = (update.acceptedPath || update.path).match(/\/@slidev\/slides\/(\d+)\/md/);
      if (match) {
        const route = nav.slides.value.find(route => route.no === Number(match[1]));
        if (route) publishedKeys.delete(String(route.meta.slide?.frontmatter.imslideId));
      }
    }
    if (blocked) { blocked = false; timer = undefined; }
    schedule();
  };
  const compileError = (payload: { err?: { message?: string } }) => fail(new Error(payload.err?.message || '幻灯片编译失败'));
  import.meta.hot?.on('vite:error', compileError);
  import.meta.hot?.on('vite:afterUpdate', afterUpdate);
  onUnmounted(() => {
    disposed = true; generation++; clearTimeout(timer); observer.disconnect(); unwatch();
    window.removeEventListener('message', receive);
    import.meta.hot?.off('vite:afterUpdate', afterUpdate);
    import.meta.hot?.off('vite:error', compileError);
    window.removeEventListener('error', runtimeError);
    window.removeEventListener('unhandledrejection', rejection);
    if (app) app.config.errorHandler = previousHandler;
  });
});
