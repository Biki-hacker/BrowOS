'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assemble } = require('../tools/asm.js');
const { runElfBinary } = require('../tools/validate.js');
const {
  RAM_BASE,
  RAM_SIZE,
  KERNEL_MAX,
  HEAP_START,
  HEAP_END,
} = require('../tools/memmap.js');

const KERNEL_DIR = path.join(__dirname, '..', 'kernel');
const KERNEL_PARTS = ['0-memmap.s', 'pmm.s', 'heap.s', 'main.s'];

function buildKernel() {
  const src = KERNEL_PARTS
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  return assemble(src);
}

function bootKernel() {
  const r = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-kernel-${process.pid}.elf`);
  fs.writeFileSync(elfPath, r.bytes);
  const res = runElfBinary(elfPath, { maxSteps: 50000000, rawBus: true, busSize: RAM_SIZE });
  fs.unlinkSync(elfPath);
  return { r, res };
}

test('kernel: physical memory self-test passes', { timeout: 300000 }, () => {
  const { res } = bootKernel();
  assert.equal(res.status, 'pass', JSON.stringify(res));
  assert.equal(res.tohost, 1);
});

test('kernel: image fits the reserved kernel region below the heap', () => {
  const r = buildKernel();
  assert.ok(r.entry >= RAM_BASE && r.entry < KERNEL_MAX);
  const end = Math.max(
    r.sections.text.base + r.sections.text.size,
    r.sections.data.base + r.sections.data.size,
    r.sections.bss.base + r.sections.bss.size
  );
  assert.ok(r.sections.text.base >= RAM_BASE && end <= KERNEL_MAX,
    'kernel image must stay within the reserved kernel region');
  assert.ok(end <= HEAP_START, 'kernel image must not overlap the heap arena');
  assert.ok(r.sections.bss.size >= 8192 + 65536 + 8192,
    'bss must hold bitmap + refcounts + stack');
});

test('kernel: heap arena fits in RAM above the kernel image', () => {
  assert.ok(HEAP_START >= KERNEL_MAX);
  assert.ok(HEAP_END > HEAP_START);
  assert.ok(HEAP_END <= RAM_SIZE);
});