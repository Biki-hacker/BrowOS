'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AnsiTerminal } = require('../web/terminal.js');

test('terminal: initial state has empty scrollback and 0 offset', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25, maxScrollback: 100 });
  assert.strictEqual(term.cols, 80);
  assert.strictEqual(term.rows, 25);
  assert.strictEqual(term.scrollback.length, 0);
  assert.strictEqual(term.scrollOffset, 0);
});

test('terminal: writing within 25 rows does not create scrollback', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25 });
  for (let i = 0; i < 20; i++) {
    term.write(`Line ${i}\n`);
  }
  assert.strictEqual(term.scrollback.length, 0);
  assert.strictEqual(term.cursorY, 20);
});

test('terminal: writing beyond 25 rows pushes lines into scrollback buffer', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25, maxScrollback: 50 });
  for (let i = 0; i < 30; i++) {
    term.write(`Line ${String(i).padStart(2, '0')}\n`);
  }

  // 30 lines written with trailing newlines:
  // First 24 lines occupy rows 0..23.
  // 25th line (i=24) + newline triggers 1st scroll (Line 00 pushed to scrollback).
  // 30th line (i=29) + newline triggers 6th scroll (Line 05 pushed to scrollback).
  assert.strictEqual(term.scrollback.length, 6);
  assert.strictEqual(term.scrollOffset, 0);

  // Check that scrollback[0] contains "Line 00"
  const line0 = term.scrollback[0].map(c => c.char).join('').trim();
  assert.strictEqual(line0, 'Line 00');

  // Check that scrollback[5] contains "Line 05"
  const line5 = term.scrollback[5].map(c => c.char).join('').trim();
  assert.strictEqual(line5, 'Line 05');
});

test('terminal: viewport row retrieval works at scroll offset 0 and positive offset', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25, maxScrollback: 50 });
  for (let i = 0; i < 30; i++) {
    term.write(`Row-${String(i).padStart(2, '0')}\n`);
  }

  assert.strictEqual(term.scrollback.length, 6);

  // When scrollOffset is 0 (bottom view), row 0 is Row-06
  const topVisibleRowOffset0 = term._getViewportRow(0).map(c => c.char).join('').trim();
  assert.strictEqual(topVisibleRowOffset0, 'Row-06');

  // Scroll back by 6 lines (scroll to very top of history)
  term.scrollTo(6);
  assert.strictEqual(term.scrollOffset, 6);

  // Now visible row 0 should be Row-00
  const topVisibleRowOffset6 = term._getViewportRow(0).map(c => c.char).join('').trim();
  assert.strictEqual(topVisibleRowOffset6, 'Row-00');

  // Visible row 5 should be Row-05 (last row in scrollback)
  const visibleRow5 = term._getViewportRow(5).map(c => c.char).join('').trim();
  assert.strictEqual(visibleRow5, 'Row-05');

  // Visible row 6 should be Row-06 (first row from active buffer)
  const visibleRow6 = term._getViewportRow(6).map(c => c.char).join('').trim();
  assert.strictEqual(visibleRow6, 'Row-06');
});

test('terminal: scrollBy and scrollTo clamp offset within [0, scrollback.length]', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25, maxScrollback: 50 });
  for (let i = 0; i < 35; i++) {
    term.write(`Test-${i}\n`);
  }
  const totalScrolled = term.scrollback.length; // 11 lines
  assert.strictEqual(totalScrolled, 11);

  // Try scrolling beyond max
  term.scrollBy(100);
  assert.strictEqual(term.scrollOffset, 11);

  // Try scrolling below 0
  term.scrollBy(-50);
  assert.strictEqual(term.scrollOffset, 0);

  // scrollToTop and scrollToBottom
  term.scrollToTop();
  assert.strictEqual(term.scrollOffset, 11);

  term.scrollToBottom();
  assert.strictEqual(term.scrollOffset, 0);
});

test('terminal: maxScrollback limit evicts older lines', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 5, maxScrollback: 10 });
  for (let i = 0; i < 50; i++) {
    term.write(`Evict-${String(i).padStart(2, '0')}\n`);
  }

  assert.strictEqual(term.scrollback.length, 10);
  // Total 50 lines + trailing newline. Active buffer has 5 lines (46..50).
  // Scrollback has 10 lines (36..45).
  const oldest = term.scrollback[0].map(c => c.char).join('').trim();
  assert.strictEqual(oldest, 'Evict-36');

  const newestInScrollback = term.scrollback[9].map(c => c.char).join('').trim();
  assert.strictEqual(newestInScrollback, 'Evict-45');
});

test('terminal: clear(false) preserves scrollback whereas clear(true) resets it', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25 });
  for (let i = 0; i < 35; i++) {
    term.write(`Line ${i}\n`);
  }
  assert.ok(term.scrollback.length > 0);

  term.clear(false);
  assert.ok(term.scrollback.length > 0);
  assert.strictEqual(term.cursorY, 0);

  term.clear(true);
  assert.strictEqual(term.scrollback.length, 0);
  assert.strictEqual(term.cursorY, 0);
});

test('terminal: backspace at start of line (cursorX=0) does not wrap to previous line', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25 });
  term.write('First Line\n');
  assert.strictEqual(term.cursorY, 1);
  assert.strictEqual(term.cursorX, 0);

  // Send backspaces
  term.write('\b\b\b');
  assert.strictEqual(term.cursorY, 1);
  assert.strictEqual(term.cursorX, 0);

  // Verify first line is completely intact
  const line0 = term.buffer[0].map(c => c.char).join('').trim();
  assert.strictEqual(line0, 'First Line');
});

test('terminal: backspace and space erasing modifies only targeted characters', () => {
  const term = new AnsiTerminal(null, { cols: 80, rows: 25 });
  term.write('browos:/$ mycmd');
  assert.strictEqual(term.cursorX, 15);

  // Simulate shell erasing "cmd" via "\b \b\b \b\b \b"
  term.write('\b \b\b \b\b \b');
  assert.strictEqual(term.cursorX, 12);

  const currentLine = term.buffer[0].map(c => c.char).join('').trim();
  assert.strictEqual(currentLine, 'browos:/$ my');
});
