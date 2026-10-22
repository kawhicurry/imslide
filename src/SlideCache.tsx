import { renderFailure, type RenderFailure } from './render-error';
import { useEffect, useRef, useState } from 'react';

export type CachedSlide = { snapshot: string; pageId: string; revision: number; page: number; total: number; html: string; width: number; height: number };
type Entry = { visible?: CachedSlide; pending?: CachedSlide };

function resizeSlide(element: HTMLIFrameElement, slide: CachedSlide) {
  const doc = element.contentDocument;
  const root = doc?.documentElement;
  if (!element.isConnected || !doc || !root || element.clientWidth <= 0 || element.clientHeight <= 0) return;
  const scale = String(Math.min(element.clientWidth / slide.width, element.clientHeight / slide.height));
  root.style.setProperty('--slidev-slide-scale', scale);
  // Slidev writes this variable inline on the content, overriding the root.
  doc.querySelector<HTMLElement>('#slide-content')?.style.setProperty('--slidev-slide-scale', scale);
}

/** Each slide keeps its last complete document while its replacement loads offscreen. */
export function SlideCache({ slides, pageId, onRendered, onError }: { slides: CachedSlide[]; pageId?: string; onRendered: (slide: CachedSlide) => void; onError: (error: RenderFailure) => void }) {
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const failed = useRef(new Set<string>());
  const [shown, setShown] = useState<string>();
  useEffect(() => {
    setEntries(previous => {
      const next: Record<string, Entry> = {};
      for (const slide of slides) {
        const old = previous[slide.pageId] || {};
        if (failed.current.has(slide.snapshot)) { next[slide.pageId] = old; continue; }
        const latest = old.pending || old.visible;
        next[slide.pageId] = latest && (latest.revision > slide.revision || (latest.revision === slide.revision && latest.html === slide.html)) ? old : { visible: old.visible, pending: slide };
      }
      // A deleted visible slide stays until its replacement is ready.
      if (shown && !next[shown] && previous[shown]) next[shown] = previous[shown];
      return next;
    });
  }, [slides, shown]);
  const target = pageId && entries[pageId]?.visible;
  useEffect(() => {
    if (target) { setShown(target.pageId); onRendered(target); }
  }, [target, onRendered]);
  return <div className="slide-cache">{Object.entries(entries).flatMap(([id, entry]) => [entry.visible, entry.pending].filter((slide): slide is CachedSlide => !!slide).map(slide =>
    <CachedDocument key={`${id}:${slide.snapshot}`} slide={slide} visible={id === shown && slide === entry.visible} onReady={() => {
      setEntries(current => current[id]?.pending === slide ? { ...current, [id]: { visible: slide } } : current);
    }} onError={error => {
      failed.current.add(slide.snapshot);
      setEntries(current => current[id]?.pending === slide ? { ...current, [id]: { visible: current[id].visible } } : current);
      onError(error);
    }}/>
  ))}</div>;
}

function CachedDocument({ slide, visible, onReady, onError }: { slide: CachedSlide; visible: boolean; onReady: () => void; onError: (error: RenderFailure) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = useRef(onReady); ready.current = onReady;
  const generation = useRef(0);
  const rejected = useRef(false);
  const completed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorHandler = useRef(onError); errorHandler.current = onError;
  function fail(error: unknown) {
    if (rejected.current || !frame.current?.isConnected) return;
    rejected.current = true; generation.current++; clearTimeout(timer.current);
    errorHandler.current(renderFailure(error, { stage: 'snapshot', revision: slide.revision, pageId: slide.pageId, snapshot: slide.snapshot }));
  }
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const resize = () => { try { resizeSlide(element, slide); } catch (error) { fail(error); } };
    if (!completed.current) timer.current = setTimeout(() => fail(new Error('页面资源加载超时')), 20000);
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    return () => { generation.current++; clearTimeout(timer.current); observer.disconnect(); };
  }, [slide]);
  async function loaded() {
    const current = ++generation.current;
    const element = frame.current, doc = element?.contentDocument;
    if (rejected.current || !element?.isConnected) return;
    if (!doc?.documentElement || !doc.querySelector('#slide-content')) throw new Error('页面结构不完整');
    resizeSlide(element, slide);
    await doc.fonts.ready;
    if (Array.from(doc.fonts).some(font => font.status === 'error')) throw new Error('页面字体加载失败');
    if (Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).some(link => !link.sheet)) throw new Error('页面样式加载失败');
    await Promise.all(Array.from(doc.images, image => image.decode()));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (generation.current === current && element.isConnected && frame.current?.contentDocument === doc) {
      resizeSlide(element, slide);
      if (rejected.current) return;
      completed.current = true; clearTimeout(timer.current);
      ready.current();
    }
  }
  return <iframe ref={frame} title={`幻灯片 ${slide.page}`} tabIndex={-1} aria-hidden={!visible} sandbox="allow-same-origin" srcDoc={slide.html} onError={() => fail(new Error('页面加载失败'))} onLoad={() => { void loaded().catch(fail); }} style={{ visibility: visible ? 'visible' : 'hidden', zIndex: visible ? 1 : 0 }}/>;
}
