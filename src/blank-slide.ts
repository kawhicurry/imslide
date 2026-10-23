import type { CachedSlide } from './SlideCache';
import type { Deck } from '../imslide';

/** Empty default pages have no generated markup to compile. Render their actual
 * canonical content immediately; Slidev can hydrate the same empty page later. */
export function blankSlide(page: { id: string; title: string; content: string; layout: string }, index: number, total: number, revision: number): CachedSlide | undefined {
  if (page.content !== '' || page.layout !== 'default') return;
  return { snapshot: `blank:${page.id}`, pageId: page.id, page: index + 1, total, revision, width: 980, height: 552,
    html: '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:white}#slide-content{width:980px;height:552px;transform:scale(var(--slidev-slide-scale,1));transform-origin:top left}</style></head><body><div id="slide-content"></div></body></html>' };
}

export function isCanonicalBlank(slide: CachedSlide): boolean {
  const canonical = blankSlide({ id: slide.pageId, title: '', content: '', layout: 'default' }, slide.page - 1, slide.total, slide.revision)!;
  return slide.snapshot === canonical.snapshot && slide.html === canonical.html && slide.width === canonical.width && slide.height === canonical.height;
}

/** Advance only caches proven to represent the preceding canonical content. A
 * stale iframe must never acquire a new revision merely because its ID matches. */
export function advanceSlideCache(cached: CachedSlide[], previous: Deck | undefined, next: Deck): CachedSlide[] {
  if (previous && next.revision < previous.revision) return cached;
  const available = new Map(cached.map(slide => [slide.pageId, slide]));
  return next.pages.flatMap((page, index) => {
    const blank = blankSlide(page, index, next.pages.length, next.revision);
    if (blank) return [blank];
    const slide = available.get(page.id);
    if (!slide) return [];
    const old = previous?.pages.find(candidate => candidate.id === page.id);
    const unchanged = old && old.content === page.content && old.layout === page.layout && old.title === page.title;
    return [unchanged && slide.revision === previous?.revision
      ? { ...slide, page: index + 1, total: next.pages.length, revision: next.revision }
      : slide];
  });
}
