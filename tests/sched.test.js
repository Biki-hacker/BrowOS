'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assemble } = require('../tools/asm.js');
const { runElfBinary } = require('../tools/validate.js');
const { RAM_SIZE } = require('../tools/memmap.js');

const KERNEL_DIR = path.join(__dirname, '..', 'kernel');
const KERNEL_PARTS = [
  '0-memmap.s',
  'pmm.s',
  'heap.s',
  'vmm.s',
  'proc.s',
  'sched.s',
  'syscall.s',
  'trap.s',
  'main.s',
];

function buildKernel() {
  const src = KERNEL_PARTS
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  return assemble(src);
}

function bootKernel(maxSteps = 20000000) {
  const r = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-sched-${process.pid}-${Date.now()}.elf`);
  fs.writeFileSync(elfPath, r.bytes);
  const res = runElfBinary(elfPath, { maxSteps, rawBus: true, busSize: RAM_SIZE });
  try { fs.unlinkSync(elfPath); } catch {}
  return { r, res };
}

test('scheduler: multi-process preemptive scheduling and syscalls pass', { timeout: 300000 }, () => {
  const { res } = bootKernel();
  assert.equal(res.status, 'pass', JSON.stringify(res));
  assert.equal(res.tohost, 1, 'tohost must be 1 on pass');
  assert.ok(res.instCount > 5000000, 'instCount reflects full self-test execution');
});

test('scheduler: kernel image contains all scheduler and syscall symbols', () => {
  const r = buildKernel();
  const expectedSymbols = [
    'vmm_init',
    'vmm_create_space',
    'vmm_map_page',
    'vmm_unmap_page',
    'vmm_switch',
    'proc_init',
    'proc_alloc',
    'proc_create',
    'proc_exit',
    'scheduler_init',
    'scheduler_tick',
    'schedule',
    'sys_yield',
    'syscall_dispatch',
    'trap_init',
    'trap_entry',
    'trap_return',
    'context_switch',
  ];

  for (const sym of expectedSymbols) {
    assert.ok(r.symbols.has(sym), `Symbol ${sym} must be present in assembled kernel`);
  }
});
