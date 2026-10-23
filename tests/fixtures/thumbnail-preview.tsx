import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SlideThumbnail } from '../../src/SlideThumbnail';
import { thumbnailQueue } from '../../src/thumbnail-queue';
import '../../src/style.css';
function snapshot(index: number, revision: number, image = '') {
  return { pageId: `p${index}`, page: index + 1, total: 60, revision, snapshot: `${index}:${revision}`, width: 980, height: 552,
    html: `<!doctype html><html><head><style>body{margin:0}#slide-content{width:980px;height:552px;background:#193d67;color:white;font:48px sans-serif;display:flex;align-items:center;justify-content:center} @media(max-width:500px){#slide-content{background:red}}</style></head><body><div id="slide-content">Page ${index} · Revision ${revision}${image ? `<img src="${image}"/>` : ''}</div></body></html>` };
}
function Fixture() {
  const [slides, setSlides] = useState(Array.from({length:60}, (_, i) => snapshot(i, 0)));
  Object.assign(window, { replaceThumbnail: (index: number, revision: number, image = '') => setSlides(old => old.map((slide, i) => i === index ? snapshot(i, revision, image) : slide)) });
  return <div className="page-list" style={{width:200,height:600,overflow:'auto'}} onScroll={() => thumbnailQueue.pause()}>
    {slides.map(slide => <div key={slide.pageId} style={{padding:10}}><SlideThumbnail slide={slide}/></div>)}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
