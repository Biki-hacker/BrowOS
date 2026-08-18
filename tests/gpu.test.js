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
const {
  RAM_SIZE,
  GPU_CTRL_BASE,
  GPU_REG_MAGIC,
  GPU_REG_VERSION,
  GPU_REG_STATUS,
  GPU_REG_FB_WIDTH,
  GPU_REG_FB_HEIGHT,
  GPU_MAGIC,
  GPU_VERSION,
  CMD_CLEAR,
  CMD_DRAW_RECT,
  CMD_DISPATCH_COMPUTE,
  CMD_PRESENT,
} = require('../tools/memmap.js');

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

test('gpu: MMIO register access, status, and resolution negotiation', () => {
  const bus = new Bus(RAM_SIZE, 0);
  const gpu = new BrowGpu(bus, { width: 320, height: 240 });
  gpu.attach(bus);

  // Magic number and version
  assert.strictEqual(bus.read32(GPU_CTRL_BASE + GPU_REG_MAGIC) >>> 0, GPU_MAGIC);
  assert.strictEqual(bus.read32(GPU_CTRL_BASE + GPU_REG_VERSION) >>> 0, GPU_VERSION);
  assert.strictEqual(bus.read32(GPU_CTRL_BASE + GPU_REG_STATUS), 1); // ready

  // Initial dimensions
  assert.strictEqual(bus.read32(GPU_CTRL_BASE + GPU_REG_FB_WIDTH), 320);
  assert.strictEqual(bus.read32(GPU_CTRL_BASE + GPU_REG_FB_HEIGHT), 240);

  // Resize to 640x480
  bus.write32(GPU_CTRL_BASE + GPU_REG_FB_WIDTH, 640);
  bus.write32(GPU_CTRL_BASE + GPU_REG_FB_HEIGHT, 480);
  assert.strictEqual(gpu.fbWidth, 640);
  assert.strictEqual(gpu.fbHeight, 480);
  assert.strictEqual(gpu.framebuffer.length, 640 * 480);
});

test('gpu: command buffer execution: CMD_CLEAR and CMD_DRAW_RECT', () => {
  const bus = new Bus(RAM_SIZE, 0);
  let presented = false;
  const gpu = new BrowGpu(bus, {
    width: 320,
    height: 240,
    onPresent: () => { presented = true; },
  });
  gpu.attach(bus);

  // Prepare command buffer at 0x10000 in RAM
  const cmdPa = 0x10000;
  let off = 0;

  // CMD_CLEAR with dark blue (0xFF800000)
  bus.write32(cmdPa + off, CMD_CLEAR); off += 4;
  bus.write32(cmdPa + off, 0xFF800000); off += 4;

  // CMD_DRAW_RECT: x=50, y=50, w=100, h=80, color=0xFF00FF00 (green)
  bus.write32(cmdPa + off, CMD_DRAW_RECT); off += 4;
  bus.write32(cmdPa + off, 50); off += 4;
  bus.write32(cmdPa + off, 50); off += 4;
  bus.write32(cmdPa + off, 100); off += 4;
  bus.write32(cmdPa + off, 80); off += 4;
  bus.write32(cmdPa + off, 0xFF00FF00); off += 4;

  // CMD_PRESENT
  bus.write32(cmdPa + off, CMD_PRESENT); off += 4;

  // Submit command buffer via MMIO
  bus.write32(GPU_CTRL_BASE + 0x18, cmdPa); // GPU_REG_CMD_ADDR
  bus.write32(GPU_CTRL_BASE + 0x1C, off);   // GPU_REG_CMD_LEN
  bus.write32(GPU_CTRL_BASE + 0x20, 1);     // GPU_REG_SUBMIT

  assert.ok(presented, 'frame should be presented');
  assert.strictEqual(gpu.framebuffer[0] >>> 0, 0xFF800000, 'background pixel must be cleared color');
  assert.strictEqual(gpu.framebuffer[60 * 320 + 60] >>> 0, 0xFF00FF00, 'rect interior must be green');
});

test('gpu: compute shader: 3D raytraced globe renders spherical geometry and lighting', () => {
  const bus = new Bus(RAM_SIZE, 0);
  const gpu = new BrowGpu(bus, { width: 320, height: 240 });
  gpu.attach(bus);

  const cmdPa = 0x20000;
  let off = 0;
  // CMD_DISPATCH_COMPUTE: kernel_id=1 (raytrace_globe), time=5
  bus.write32(cmdPa + off, CMD_DISPATCH_COMPUTE); off += 4;
  bus.write32(cmdPa + off, 1); off += 4; // kernel 1 = raytrace_globe
  bus.write32(cmdPa + off, 5); off += 4; // time = 5
  bus.write32(cmdPa + off, 0); off += 4;
  bus.write32(cmdPa + off, 0); off += 4;
  bus.write32(cmdPa + off, CMD_PRESENT); off += 4;

  bus.write32(GPU_CTRL_BASE + 0x18, cmdPa);
  bus.write32(GPU_CTRL_BASE + 0x1C, off);
  bus.write32(GPU_CTRL_BASE + 0x20, 1);

  // Sphere center pixel (160, 120) should have valid Earth surface lighting (alpha = 0xFF, non-zero RGB)
  const centerPixel = gpu.framebuffer[120 * 320 + 160] >>> 0;
  assert.strictEqual((centerPixel >>> 24) & 0xFF, 0xFF, 'alpha must be opaque 0xFF');
  const r = centerPixel & 0xFF;
  const g = (centerPixel >>> 8) & 0xFF;
  const b = (centerPixel >>> 16) & 0xFF;
  assert.ok(r > 0 || g > 0 || b > 0, 'center sphere pixel must have visible illuminated color');

  // Corner pixel (0, 0) should be deep space / atmospheric halo
  const cornerPixel = gpu.framebuffer[0] >>> 0;
  assert.strictEqual((cornerPixel >>> 24) & 0xFF, 0xFF);
});

test('gpu: guest userland application dispatches compute raytracer via sys_gpu_dispatch', { timeout: 300000 }, () => {
  const globeSrc = fs.readFileSync(path.join(USER_DIR, 'globe.s'), 'utf8');
  const globeElf = buildUserProgram(globeSrc);

  const diskBytes = formatDisk(2048, [
    { path: 'sh', content: globeElf.bytes },
  ]);

  const k = buildKernel();
  const elfPath = path.join(os.tmpdir(), `browos-gpu-${process.pid}-${Date.now()}.elf`);
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

  let presentedFrames = 0;
  const gpu = new BrowGpu(bus, {
    width: 320,
    height: 240,
    onPresent: () => { presentedFrames++; },
  });
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
  assert.ok(output.includes('BrowGPU: Raytracing complete. Frame presented.'), `UART output should confirm raytracing completion, got: ${output}`);
  assert.ok(presentedFrames >= 1, 'at least 1 frame must be presented via BrowGPU');
  assert.strictEqual(tohostValue, 1, 'kernel must report pass via tohost');
});
