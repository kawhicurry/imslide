import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankSlide, advanceSlideCache, isCanonicalBlank } from '../src/blank-slide.ts';

test('only an actually empty default page can bypass compilation, with canonical identity', () => {
  const page = { id: 'new-page', title: '空白页面', content: '', layout: 'default' };
  const result = blankSlide(page, 2, 4, 9)!;
  assert.equal(result.pageId, page.id); assert.equal(result.page, 3);
  assert.equal(result.total, 4); assert.equal(result.revision, 9);
  assert.equal(isCanonicalBlank(result), true);
  assert.equal(isCanonicalBlank({ ...result, html: result.html.replace('<div id="slide-content"></div>', '<div id="slide-content">真实正文</div>') }), false);
  assert.equal(isCanonicalBlank({ ...result, snapshot: 'compiled-nonempty' }), false);
  assert.equal(blankSlide({ ...page, content: '# 不能预先显示为空白' }, 2, 4, 9), undefined);
  assert.equal(blankSlide({ ...page, layout: 'cover' }, 2, 4, 9), undefined);
});

test('unchanged canonical pages reuse their snapshot while stale or changed content cannot gain a newer revision', () => {
  const page = { id: 'existing', title: 'A', content: '# A', layout: 'default' as const };
  const before = { pages: [page], current: 0, revision: 4 };
  const cached = { ...blankSlide({ ...page, content: '' }, 0, 1, 4)!, html: '<div># A</div>', snapshot: 'rendered-A' };
  const next = { ...before, revision: 5 };
  const reused = advanceSlideCache([cached], before, next)[0];
  assert.equal(reused.snapshot, 'rendered-A'); assert.equal(reused.revision, 5);
  const changed = { ...next, pages: [{ ...page, content: '# B' }] };
  assert.equal(advanceSlideCache([cached], before, changed)[0].revision, 4);
  assert.equal(advanceSlideCache([{ ...cached, revision: 3 }], before, next)[0].revision, 3);
});
