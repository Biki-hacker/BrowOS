'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assemble } = require('../tools/asm.js');
const { readElf, loadSegments } = require('../tools/elf.js');
const { Bus } = require('../tools/mem.js');
const { Cpu } = require('../tools/cpu.js');
const { Uart, BlockDevice, BrowGpu } = require('../tools/devices.js');
const { formatDisk } = require('../tools/mkfs.js');
const { RAM_SIZE } = require('../tools/memmap.js');

const KERNEL_DIR = path.join(__dirname, '..', 'kernel');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const KERNEL_PARTS = [
  '0-memmap.s',
  'pmm.s',
  'heap.s',
  'vmm.s',
  'proc.s',
  'sched.s',
  'signal.s',
  'pipe.s',
  'driver_gpu.s',
  'syscall.s',
  'trap.s',
  'driver_uart.s',
  'driver_blk.s',
  'fs.s',
  'exec.s',
];

function buildKernel(withMain) {
  const parts = withMain ? [...KERNEL_PARTS, 'main.s'] : KERNEL_PARTS;
  const src = parts
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  return assemble(src);
}

function runFsTests(maxSteps = 100000000) {
  const fstestSrc = fs.readFileSync(path.join(FIXTURES_DIR, 'fstest_main.s'), 'utf8');
  const src = KERNEL_PARTS
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  const full = assemble(src + '\n' + fstestSrc);

  const diskBytes = formatDisk(2048, []);
  const elfPath = path.join(os.tmpdir(), `browos-fstest-${process.pid}-${Date.now()}.elf`);
  fs.writeFileSync(elfPath, full.bytes);
  const elfBytes = fs.readFileSync(elfPath);
  const elf = readElf(elfBytes);
  fs.unlinkSync(elfPath);

  const bus = new Bus(RAM_SIZE, 0);
  loadSegments(bus, elfBytes, elf);

  const uart = new Uart();
  uart.attach(bus);

  const blk = new BlockDevice(2048, bus);
  blk.disk.set(diskBytes);
  blk.attach(bus);

  const gpu = new BrowGpu(bus);
  gpu.attach(bus);

  const tohostAddr = elf.symbols['tohost'] ? elf.symbols['tohost'].value : null;
  let tohostValue = null;
  let pending = null;

  const cpu = new Cpu(bus, { pc: elf.entry, trace: () => {} });

  if (tohostAddr !== null) {
    const origWrite32 = bus.write32.bind(bus);
    bus.write32 = (addr, v) => {
      const a = addr >>> 0;
      if (a === (tohostAddr >>> 0)) {
        pending = { value: v | 0, resolveStep: cpu.instCount + 8 };
        return;
      }
      origWrite32(addr, v);
    };
  }

  cpu.trace = (c) => {
    if (pending && c.instCount >= pending.resolveStep) {
      const p = pending;
      pending = null;
      tohostValue = p.value;
      c.stop();
    }
  };
  cpu.run(maxSteps);

  return { tohost: tohostValue, instCount: cpu.instCount };
}

test('fs: kernel image exports all BrFS filesystem functions', () => {
  const r = buildKernel(true);
  const expectedSymbols = [
    'fs_init',
    'fs_alloc_block',
    'fs_free_block',
    'fs_read_inode',
    'fs_write_inode',
    'fs_alloc_inode',
    'fs_create',
    'fs_lookup',
    'fs_read',
    'fs_write',
    'fs_unlink',
    'fs_mkdir',
    'fs_dir_add',
    'fs_dir_empty',
    'fs_dir_name_of',
    'fs_resolve',
    'fs_resolve_parent',
    'fs_truncate',
    'fs_bmap',
    'uart_init',
    'uart_putc',
    'uart_puts',
    'uart_getc',
    'blk_init',
    'blk_read_sector',
    'blk_write_sector',
    'blk_capacity',
    'elf_load',
    'sys_exec',
  ];

  for (const sym of expectedSymbols) {
    assert.ok(r.symbols.has(sym), `Symbol ${sym} must be present in assembled kernel`);
  }
});

test('fs: filesystem driver passes all kernel-level tests', { timeout: 300000 }, () => {
  const { tohost, instCount } = runFsTests();
  assert.equal(tohost, 1, `fstest driver must pass (tohost=${tohost}, instCount=${instCount})`);
});
