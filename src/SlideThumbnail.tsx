import { memo, useEffect, useRef, useState } from 'react';
import { CachedDocument, type CachedSlide } from './SlideCache';
import { thumbnailQueue } from './thumbnail-queue';

/** Offscreen pages retain their source cache, but no live iframe documents. */
export const SlideThumbnail = memo(function SlideThumbnail({ slide }: { slide?: CachedSlide }) {
  const host = useRef<HTMLSpanElement>(null);
  const [nearby, setNearby] = useState(false);
  useEffect(() => {
    const element = host.current!;
    const observer = new IntersectionObserver(([entry]) => setNearby(entry.isIntersecting), {
      root: element.closest('.page-list'), rootMargin: '100px',
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <span ref={host} className="thumbnail" aria-hidden="true">
    {nearby && slide && <ThumbnailDocument slide={slide}/>}
  </span>;
});

function ThumbnailDocument({ slide }: { slide: CachedSlide }) {
  const host = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState<CachedSlide>();
  const [pending, setPending] = useState<CachedSlide>();
  const finish = useRef<() => void>(() => {});
  const visibleRef = useRef(visible); visibleRef.current = visible;
  useEffect(() => {
    if (visibleRef.current?.snapshot === slide.snapshot) return;
    setPending(undefined);
    const cancel = thumbnailQueue.enqueue(done => { finish.current = done; setPending(slide); });
    return () => { finish.current = () => {}; cancel(); };
    // Metadata-only revisions must not cancel/reload a document.
  }, [slide.snapshot]);
  useEffect(() => {
    const element = host.current!;
    const resize = () => {
      for (const frame of element.querySelectorAll<HTMLIFrameElement>('iframe')) {
        const width = Number(frame.getAttribute('width'));
        const height = Number(frame.getAttribute('height'));
        frame.style.transform = `scale(${Math.min(element.clientWidth / width, element.clientHeight / height)})`;
      }
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    return () => observer.disconnect();
  }, [visible, pending]);
  return <span ref={host} className="thumbnail-documents" style={{ aspectRatio: `${visible?.width || slide.width}/${visible?.height || slide.height}` }}>
    {[visible, pending].filter((value): value is CachedSlide => !!value).map(document =>
      <CachedDocument key={document.snapshot} slide={document} fixedViewport visible={document === visible}
        onReady={() => {
          if (document !== pending) return;
          setVisible(document); setPending(undefined); finish.current();
        }}
        onError={() => { if (document === pending) { setPending(undefined); finish.current(); } }}/>
    )}
  </span>;
}
