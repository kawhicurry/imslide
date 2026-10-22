import { defineRootSetup } from '@slidev/types';
import { configs, disableBuiltinSync, useNav } from '@slidev/client';
import { nextTick, watch } from 'vue';

/** Renderer adapter: acknowledge the actual Slidev page, not just its URL. */
export default defineRootSetup(() => {
  if (window.parent === window || !location.search.includes('embedded') || !document.referrer) return;
  const parentOrigin = new URL(document.referrer).origin;
  const nav = useNav();
  disableBuiltinSync();
  let desired: { pageId: string; revision: number } | undefined;
  const revision = (meta: Record<string, unknown>) => meta.imslideRevision ?? (configs as { imslide?: { revision?: number } }).imslide?.revision;
  function report() {
    const meta = nav.currentFrontmatter.value;
    window.parent.postMessage({ type: 'imslide:rendered', pageId: meta.imslideId, revision: revision(meta), page: nav.currentSlideNo.value, total: nav.total.value }, parentOrigin);
  }
  async function sync() {
    if (!desired) { report(); return; }
    const target = nav.slides.value.find(slide => {
      const meta = slide.meta.slide?.frontmatter;
      return meta?.imslideId === desired?.pageId && revision(meta) === desired.revision;
    });
    // Wait for HMR to load the right revision instead of navigating through stale routes.
    if (!target) return;
    if (nav.currentSlideNo.value !== target.no) await nav.go(target.no);
    await nextTick(); report();
  }
  const receive = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== parentOrigin || event.data?.type !== 'imslide:navigate') return;
    if (typeof event.data.pageId !== 'string' || !Number.isInteger(event.data.revision)) return;
    desired = { pageId: event.data.pageId, revision: event.data.revision };
    void sync();
  };
  window.addEventListener('message', receive);
  const unwatch = watch(() => [nav.currentSlideNo.value, nav.currentFrontmatter.value, nav.slides.value, (configs as { imslide?: unknown }).imslide], () => { void sync(); }, { deep: true, flush: 'post', immediate: true });
  if (import.meta.hot) import.meta.hot.dispose(() => { window.removeEventListener('message', receive); unwatch(); });
});
