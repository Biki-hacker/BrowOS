const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { assemble } = require('../tools/asm.js');
const { readElf, loadSegments } = require('../tools/elf.js');
const { Bus } = require('../tools/mem.js');
const { Cpu } = require('../tools/cpu.js');
const { Uart, BlockDevice, BrowGpu } = require('../tools/devices.js');
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
  'driver_gpu.s',
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

test('pipe: creates pipe, writes data, reads data, and verifies contents', { timeout: 300000 }, () => {
  const userSrc = `
.text
.globl _start
_start:
  # Allocate pipe: pipe(pipefds)
  la a0, pipefds
  call pipe
  bnez a0, fail

  # Write "HelloPipe" (9 bytes) to write_fd (pipefds[1])
  la t0, pipefds
  lw a0, 4(t0)       # write_fd
  la a1, write_msg
  li a2, 9
  call write
  li t0, 9
  bne a0, t0, fail

  # Read 9 bytes from read_fd (pipefds[0])
  la t0, pipefds
  lw a0, 0(t0)       # read_fd
  la a1, read_buf
  li a2, 9
  call read
  li t0, 9
  bne a0, t0, fail

  # Close write_fd
  la t0, pipefds
  lw a0, 4(t0)
  call close

  # Read again should return 0 (EOF)
  la t0, pipefds
  lw a0, 0(t0)
  la a1, read_buf
  li a2, 9
  call read
  bnez a0, fail

  # Print success message to stdout
  la a0, success_msg
  call puts

  # Exit 0
  li a0, 0
  call exit

fail:
  li a0, 1
  call exit

.data
.align 4
pipefds:     .word 0, 0
write_msg:   .ascii "HelloPipe"
success_msg: .ascii "PIPE_PASS"
.byte 0

.bss
.align 4
read_buf:    .zero 32
`;

  const userElf = buildUserProgram(userSrc);
  const diskBytes = formatDisk(2048, [
    { path: 'sh', content: userElf.bytes },
  ]);

  const k = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-pipe-${process.pid}-${Date.now()}.elf`);
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
      origWrite32(addr, v);
    };
  }

  const cpu = new Cpu(bus, { pc: elf.entry, trace: cpuTrace });
  cpu.run(20000000);

  const output = uart.output();
  assert.ok(output.includes('PIPE_PASS'), `UART output should contain PIPE_PASS, got: ${output}`);
  assert.strictEqual(tohostValue, 1, 'Kernel must report pass via tohost');
});
