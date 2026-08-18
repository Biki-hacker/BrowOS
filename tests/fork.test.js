const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
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

function buildUserProgram(assemblySrc) {
  const libSrc = fs.readFileSync(path.join(USER_DIR, 'libbrow.s'), 'utf8');
  return assemble(libSrc + '\n' + assemblySrc, { base: 0x40000000 });
}

test('fork: parent forks child process and reaps exit code with waitpid', { timeout: 300000 }, () => {
  const userSrc = `
.text
.globl _start
_start:
  # Fork process: fork()
  call fork
  beqz a0, is_child

  # Parent process: a0 = child PID
  mv s0, a0

  # Wait for child: waitpid(child_pid, &status)
  mv a0, s0
  la a1, status_val
  call waitpid

  # Check status == 42
  la t0, status_val
  lw t1, 0(t0)
  li t2, 42
  bne t1, t2, fail

  # Print success message to stdout
  la a0, success_msg
  call puts

  # Exit 0
  li a0, 0
  call exit

is_child:
  # Child process: exit with status 42
  li a0, 42
  call exit

fail:
  li a0, 1
  call exit

.data
.align 4
status_val:  .word 0
success_msg: .ascii "FORK_PASS"
.byte 0
`;

  const userElf = buildUserProgram(userSrc);
  const diskBytes = formatDisk(2048, [
    { path: 'sh', content: userElf.bytes },
  ]);

  const k = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-fork-${process.pid}-${Date.now()}.elf`);
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

  const output = uart.output();
  assert.ok(output.includes('FORK_PASS'), `UART output should contain FORK_PASS, got: ${output}`);
  assert.strictEqual(tohostValue, 1, 'Kernel must report pass via tohost');
});
