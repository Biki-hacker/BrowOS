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
const { Uart, BlockDevice } = require('../tools/devices.js');
const { formatDisk } = require('../tools/mkfs.js');
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
  'driver_uart.s',
  'driver_blk.s',
  'fs.s',
  'exec.s',
  'main.s',
];

function buildKernel() {
  const src = KERNEL_PARTS
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  return assemble(src);
}

function buildUserProgram(assemblySrc) {
  return assemble(assemblySrc, { base: 0x40000000 });
}

test('exec: user program assembled with libbrow loads and executes from BrFS', { timeout: 300000 }, () => {
  // 1. Build user hello program
  const userSrc = `
.text
.globl _start
_start:
  la a0, msg
  li a7, 6   # SYS_WRITE
  li a0, 1   # stdout
  la a1, msg
  li a2, 16  # length
  ecall

  # Exit with status 42
  li a7, 1   # SYS_EXIT
  li a0, 42
  ecall

.data
msg: .ascii "Hello from ELF!\\n"
`;
  const userElf = buildUserProgram(userSrc);
  assert.ok(userElf.bytes.length > 0, 'user ELF binary generated');

  // 2. Format disk with user binary as /sh
  const diskBytes = formatDisk(2048, [
    { path: 'sh', content: userElf.bytes },
  ]);

  // 3. Assemble kernel
  const k = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-exec-${process.pid}-${Date.now()}.elf`);
  fs.writeFileSync(elfPath, k.bytes);
  const elfBytes = fs.readFileSync(elfPath);
  const elf = readElf(elfBytes);

  const bus = new Bus(RAM_SIZE, 0);
  loadSegments(bus, elfBytes, elf);
  fs.unlinkSync(elfPath);

  const uart = new Uart();
  uart.attach(bus);

  const blk = new BlockDevice(2048, bus);
  blk.disk.set(diskBytes);
  blk.attach(bus);

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
      origWrite32(addr, v);
    };
  }

  const cpu = new Cpu(bus, { pc: elf.entry, trace: cpuTrace });
  cpu.run(20000000);

  const uartOut = uart.output();
  assert.ok(uartOut.includes('Hello from ELF!'), `UART output must contain user program text, got: "${uartOut}"`);
});
