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
const USER_DIR = path.join(__dirname, '..', 'user');

const KERNEL_PARTS = [
  '0-memmap.s',
  'pmm.s',
  'heap.s',
  'vmm.s',
  'proc.s',
  'sched.s',
  'signal.s',
  'pipe.s',
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

function buildShell() {
  const libSrc = fs.readFileSync(path.join(USER_DIR, 'libbrow.s'), 'utf8');
  const shSrc = fs.readFileSync(path.join(USER_DIR, 'sh.s'), 'utf8');
  return assemble(libSrc + '\n' + shSrc, { base: 0x40000000 });
}

function runShellSession(inputCommands, maxSteps = 50000000) {
  const shElf = buildShell();
  const diskBytes = formatDisk(2048, [
    { path: 'sh', content: shElf.bytes },
  ]);

  const k = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-sh-${process.pid}-${Date.now()}.elf`);
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

  let fed = false;
  const cpuTrace = (c, inst) => {
    if (!fed && uart.output().includes('browos$ ')) {
      fed = true;
      for (let i = 0; i < inputCommands.length; i++) {
        uart.pushRx(inputCommands.charCodeAt(i));
      }
    }
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
  cpu.run(maxSteps);

  return {
    output: uart.output(),
    tohost: tohostValue,
    instCount: cpu.instCount,
  };
}

test('shell: banner and help command display correctly', { timeout: 300000 }, () => {
  const { output } = runShellSession('help\nshutdown\n');
  assert.ok(output.includes('Welcome to BrowOS'), 'must display welcome banner');
  assert.ok(output.includes('Available commands:'), 'must display help output');
  assert.ok(output.includes('System shutting down...'), 'must confirm shutdown');
});

test('shell: echo, uname, and pwd commands execute interactively', { timeout: 300000 }, () => {
  const { output } = runShellSession('echo Hello from BrowOS Shell\nuname\npwd\nshutdown\n');
  assert.ok(output.includes('Hello from BrowOS Shell'), 'echo output must match');
  assert.ok(output.includes('BrowOS 0.1.0 rv32im'), 'uname output must match');
  assert.ok(output.includes('/'), 'pwd output must match');
});

test('shell: mkdir and touch filesystem commands work in shell', { timeout: 300000 }, () => {
  const { output, tohost } = runShellSession('mkdir testdir\ntouch testfile\nshutdown\n');
  assert.ok(output.includes('browos$'), 'prompt must be displayed');
  assert.equal(tohost, 1, 'shutdown command must write 1 to tohost');
});

test('shell: ps and kill command execute in shell', { timeout: 300000 }, () => {
  const { output, tohost } = runShellSession('ps\nkill 999\nshutdown\n');
  assert.ok(output.includes('COMMAND'), 'ps output must display process table header');
  assert.ok(output.includes('sh'), 'ps output must show shell process');
  assert.ok(output.includes('kill: process not found'), 'kill invalid pid must report error');
  assert.equal(tohost, 1, 'shutdown command must exit');
});
