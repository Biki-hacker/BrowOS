const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { bundle } = require('../tools/bundle.js');

test('bundle: generates standalone single-file index.html distribution', () => {
  const result = bundle();
  assert.ok(fs.existsSync(result.htmlPath), 'index.html must exist on disk');
  assert.ok(result.size > 1000000, 'index.html must contain full embedded system (>1 MB)');

  const html = fs.readFileSync(result.htmlPath, 'utf8');

  // Verify essential structure
  assert.ok(html.includes('<!DOCTYPE html>'), 'must be valid HTML5');
  assert.ok(html.includes('id="term-canvas"'), 'must include terminal canvas');
  assert.ok(html.includes('id="gpu-canvas"'), 'must include BrowGPU canvas');
  assert.ok(html.includes('BROWOS_KERNEL_ELF'), 'must embed kernel ELF');
  assert.ok(html.includes('BROWOS_DISK_IMG'), 'must embed BrFS disk image');
  assert.ok(html.includes('class Cpu'), 'must embed CPU emulator');
  assert.ok(html.includes('class BrowGpu'), 'must embed BrowGPU');
  assert.ok(html.includes('class AnsiTerminal'), 'must embed ANSI terminal emulator');
});
