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
const { RAM_SIZE } = require('../tools/memmap.js');

const KERNEL_DIR = path.join(__dirname, '..', 'kernel');
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
  'main.s',
];

const DISK_SECTORS = 2048;

function buildKernel() {
  const src = KERNEL_PARTS
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  return assemble(src);
}

function bootKernel(maxSteps = 50000000) {
  const r = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-sched-${process.pid}-${Date.now()}.elf`);
  fs.writeFileSync(elfPath, r.bytes);
  const elfBytes = fs.readFileSync(elfPath);
  const elf = readElf(elfBytes);

  const bus = new Bus(RAM_SIZE, 0);
  loadSegments(bus, elfBytes, elf);
  fs.unlinkSync(elfPath);

  const uart = new Uart();
  uart.attach(bus);
  const blk = new BlockDevice(DISK_SECTORS, bus);
  blk.attach(bus);
  const gpu = new BrowGpu(bus);
  gpu.attach(bus);

  const tohostAddr = elf.symbols['tohost'] ? elf.symbols['tohost'].value : null;
  let tohostValue = null;
  let pending = null;

  const cpuTrace = (c, inst) => {
    if (pending && c.instCount >= pending.resolveStep) {
      const p = pending;
      pending = null;
      if (p.value === 1 || (p.value & 1)) {
        tohostValue = p.value;
        c.stop();
      }
    }
  };

  if (tohostAddr !== null) {
    const origWrite32 = bus.write32.bind(bus);
    bus.write32 = (addr, v) => {
      const a = addr >>> 0;
      if (a === (tohostAddr >>> 0)) {
        pending = { value: v | 0, resolveStep: cpu.instCount + 8 };
        return;
      }
      const fromhostAddr = (tohostAddr + 4) >>> 0;
      if (a === fromhostAddr) {
        const p = pending;
        pending = null;
        if (p && (v >>> 0) !== 0x1010000) {
          tohostValue = p.value;
          cpu.stop();
        }
        return;
      }
      origWrite32(addr, v);
    };
  }

  const cpu = new Cpu(bus, { pc: elf.entry, trace: cpuTrace });
  const result = cpu.run(maxSteps);

  const status = tohostValue === 1 ? 'pass' : tohostValue !== null ? 'fail' : 'timeout';
  return {
    r,
    res: {
      status,
      tohost: tohostValue,
      instCount: cpu.instCount,
      steps: result.instCount,
      pc: cpu.pc,
      priv: cpu.priv,
      halted: result.halted,
      haltReason: result.reason,
    },
  };
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
