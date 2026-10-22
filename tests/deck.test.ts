import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialDeck, navigate, renderDeck, pageSchema, parseDeck, deleteCurrentPage, clearPresentation } from '../imslide.ts';

test('start with exactly one truly blank page', () => {
  const deck = initialDeck();
  assert.equal(deck.pages.length, 1); assert.equal(deck.current, 0); assert.equal(deck.pages[0].content, '');
});
test('next adds at end; previous and goto preserve content and page identity', () => {
  let deck = initialDeck();
  deck.pages[0].content = '# 第一页'; const firstId = deck.pages[0].id;
  deck = navigate(deck, 'next'); assert.equal(deck.current, 1); assert.equal(deck.pages.length, 2);
  deck.pages[1].content = '# 第二页';
  deck = navigate(deck, 'previous'); assert.equal(deck.current, 0); assert.equal(deck.pages[0].id, firstId);
  deck = navigate(deck, 'next'); assert.equal(deck.pages.length, 2); assert.equal(deck.pages[1].content, '# 第二页');
  deck = navigate(deck, 'goto', 1); assert.equal(deck.pages[0].content, '# 第一页');
  assert.throws(() => navigate(deck, 'goto', 9));
  assert.equal(navigate(deck, 'previous').current, 0);
});
test('inserting a blank page keeps following pages', () => {
  let deck = navigate(initialDeck(), 'next'); const secondId = deck.pages[1].id;
  deck = navigate(deck, 'previous'); deck = navigate(deck, 'add');
  assert.equal(deck.current, 1); assert.equal(deck.pages.length, 3); assert.equal(deck.pages[2].id, secondId);
});
test('single-page tools reject executable content and extra pages', () => {
  for (const content of ['# Hi\n---\n# second', '<script>alert(1)</script>', '<img onerror="alert(1)">', '{{ window.alert(1) }}', '<div v-html="x">']) {
    assert.equal(pageSchema.safeParse({id:'a',title:'x',layout:'default',content}).success, false);
  }
  assert.equal(pageSchema.safeParse({ id:'a', title:'x', layout:'center', content:'# Hello\n<style>h1 { color: green }</style>' }).success, true);
});
test('export keeps single deck headmatter and per-page layouts', () => {
  const deck = navigate(initialDeck(), 'next'); deck.pages[1].layout = 'center'; deck.pages[1].content = '# B';
  const markdown = renderDeck(deck);
  assert.equal((markdown.match(/theme: default/g) || []).length, 1);
  assert.deepEqual(parseDeck(markdown), deck);
});

test('single file preserves notes, whitespace and layout across reopen', () => {
  for (const body of ['# A\n\n<!-- speaker notes -->', '\n# trailing\n\n', '    indented code  ', '']) {
    const deck = initialDeck(); deck.pages[0].content = body;
    assert.deepEqual(parseDeck(renderDeck(deck)), deck);
  }
});

test('delete selects the next page, or previous when deleting the last page, preserving other pages', () => {
  let deck = initialDeck(); deck.pages[0].content = '# A';
  deck = navigate(deck, 'next'); deck.pages[1].content = '# B';
  deck = navigate(deck, 'next'); deck.pages[2].content = '# C';
  deck = navigate(deck, 'goto', 2);
  const ids = deck.pages.map(page => page.id);
  const middleDeleted = deleteCurrentPage(deck);
  assert.equal(deck.pages.length, 3, 'input state is unchanged');
  assert.deepEqual(middleDeleted.pages.map(page => page.id), [ids[0], ids[2]]);
  assert.equal(middleDeleted.current, 1); assert.equal(middleDeleted.pages[1].content, '# C');
  const lastDeleted = deleteCurrentPage(middleDeleted);
  assert.equal(lastDeleted.current, 0); assert.equal(lastDeleted.pages[0].content, '# A');
  const onlyDeleted = deleteCurrentPage(lastDeleted);
  assert.equal(onlyDeleted.current, 0); assert.equal(onlyDeleted.pages.length, 1);
  assert.equal(onlyDeleted.pages[0].content, ''); assert.notEqual(onlyDeleted.pages[0].id, ids[0]);
  assert.equal(onlyDeleted.revision, deck.revision + 3);
});
test('clear presentation keeps one fresh blank page and persists the reset with a new revision', () => {
  let deck = initialDeck(); deck.pages[0].content = '# Existing';
  deck = navigate(deck, 'next'); deck.pages[1].content = '# More';
  const cleared = clearPresentation(deck);
  assert.equal(cleared.current, 0); assert.equal(cleared.pages.length, 1);
  assert.equal(cleared.pages[0].content, ''); assert.equal(cleared.pages[0].layout, 'default');
  assert.equal(cleared.revision, deck.revision + 1);
  assert.ok(!deck.pages.some(page => page.id === cleared.pages[0].id));
  assert.deepEqual(parseDeck(renderDeck(cleared)), cleared);
});
