'use strict';

/**
 * devices.js — Virtual hardware devices for BrowOS.
 *
 * Each device is an object with read8/write8 (and optionally read32/write32)
 * methods keyed to their MMIO address range.
 */

const {
  UART_BASE,
  BLOCK_BASE,
  GPU_CTRL_BASE,
  GPU_MAGIC,
  GPU_VERSION,
  GPU_REG_MAGIC,
  GPU_REG_VERSION,
  GPU_REG_STATUS,
  GPU_REG_FB_WIDTH,
  GPU_REG_FB_HEIGHT,
  GPU_REG_FB_ADDR,
  GPU_REG_CMD_ADDR,
  GPU_REG_CMD_LEN,
  GPU_REG_SUBMIT,
  GPU_REG_PRESENT,
  GPU_REG_BACKEND,
  CMD_CLEAR,
  CMD_DRAW_RECT,
  CMD_BLIT,
  CMD_DISPATCH_COMPUTE,
  CMD_PRESENT,
} = require('./memmap.js');

// ─── 16550A UART ───────────────────────────────────────────────────────────────

const UART_SIZE = 0x100; // 256-byte register window

// Register offsets (relative to UART_BASE)
const UART_RBR = 0; // Receive Buffer Register  (read, DLAB=0)
const UART_THR = 0; // Transmitter Holding Reg  (write, DLAB=0)
const UART_IER = 1; // Interrupt Enable Register
const UART_IIR = 2; // Interrupt Identification Register (read)
const UART_FCR = 2; // FIFO Control Register    (write)
const UART_LCR = 3; // Line Control Register
const UART_MCR = 4; // Modem Control Register
const UART_LSR = 5; // Line Status Register
const UART_MSR = 6; // Modem Status Register
const UART_SCR = 7; // Scratch Register

// LSR bits
const LSR_DATA_READY = 0x01;
const LSR_TX_EMPTY   = 0x20;
const LSR_TX_IDLE    = 0x40;

class Uart {
  /**
   * @param {object} [opts]
   * @param {function(number):void} [opts.onTx] Called with each transmitted byte.
   */
  constructor(opts = {}) {
    this.onTx = opts.onTx || null;
    this.rxFifo = [];       // characters waiting to be read
    this.ier = 0;
    this.lcr = 0x03;        // 8-N-1
    this.mcr = 0;
    this.scr = 0;
    this.fifosEnabled = 0;
    this.txBuf = [];        // transmitted bytes (for test inspection)
  }

  /** Push a character into the receive FIFO (as if typed on the console). */
  pushRx(byte) {
    this.rxFifo.push(byte & 0xFF);
  }

  /** Attach this UART to a bus at UART_BASE. */
  attach(bus) {
    bus.mapDevice(UART_BASE, UART_SIZE, this);
  }

  // ─── Register accessors ─────────────────────────────────────────────
  read8(addr) {
    const off = (addr >>> 0) - (UART_BASE >>> 0);
    switch (off) {
      case UART_RBR:
        if (this.rxFifo.length > 0) return this.rxFifo.shift();
        return 0;
      case UART_IER: return this.ier;
      case UART_IIR: {
        // No pending interrupt for now — return 0x01 (no interrupt pending)
        // With FIFOs enabled bit 7:6 = 11
        const fifoFlag = this.fifosEnabled ? 0xC0 : 0;
        return fifoFlag | 0x01;
      }
      case UART_LCR: return this.lcr;
      case UART_MCR: return this.mcr;
      case UART_LSR: {
        let lsr = LSR_TX_EMPTY | LSR_TX_IDLE; // TX always ready
        if (this.rxFifo.length > 0) lsr |= LSR_DATA_READY;
        return lsr;
      }
      case UART_MSR: return 0;
      case UART_SCR: return this.scr;
      default: return 0;
    }
  }

  write8(addr, val) {
    const off = (addr >>> 0) - (UART_BASE >>> 0);
    const v = val & 0xFF;
    switch (off) {
      case UART_THR:
        this.txBuf.push(v);
        if (this.onTx) this.onTx(v);
        break;
      case UART_IER: this.ier = v & 0x0F; break;
      case UART_FCR:
        this.fifosEnabled = (v & 1) ? 1 : 0;
        if (v & 2) this.rxFifo.length = 0; // clear RX FIFO
        break;
      case UART_LCR: this.lcr = v; break;
      case UART_MCR: this.mcr = v & 0x1F; break;
      case UART_SCR: this.scr = v; break;
      default: break;
    }
  }

  // 32-bit access helpers (the bus read32/write32 use these)
  read32(addr) {
    const a = addr >>> 0;
    return this.read8(a) |
           (this.read8(a + 1) << 8) |
           (this.read8(a + 2) << 16) |
           (this.read8(a + 3) << 24);
  }

  write32(addr, v) {
    const a = addr >>> 0;
    this.write8(a, v & 0xFF);
    this.write8(a + 1, (v >>> 8) & 0xFF);
    this.write8(a + 2, (v >>> 16) & 0xFF);
    this.write8(a + 3, (v >>> 24) & 0xFF);
  }

  /** Returns the transmitted output as a UTF-8 string. */
  output() {
    return String.fromCharCode(...this.txBuf);
  }

  /** True when there is RX data and RX interrupts are enabled. */
  get irqPending() {
    return (this.ier & 0x01) && this.rxFifo.length > 0;
  }
}

// ─── RAM-backed Block Device ───────────────────────────────────────────────────

const BLK_SIZE = 0x100; // 256-byte register window

// Register offsets (relative to BLOCK_BASE)
const BLK_STATUS    = 0x00; // R: 0=idle,1=busy,2=done-ok,3=done-err
const BLK_COMMAND   = 0x04; // W: 1=read, 2=write
const BLK_SECTOR    = 0x08; // RW: sector number (LBA)
const BLK_DMA_ADDR  = 0x0C; // RW: guest physical address for DMA
const BLK_CAPACITY  = 0x10; // R: total number of 512-byte sectors
const BLK_SECT_SIZE = 0x14; // R: sector size in bytes (always 512)

const SECTOR_SIZE = 512;
const BLK_CMD_READ  = 1;
const BLK_CMD_WRITE = 2;

class BlockDevice {
  /**
   * @param {number} totalSectors Total disk capacity in 512-byte sectors.
   * @param {Bus} bus Reference to the system bus (for DMA).
   */
  constructor(totalSectors, bus) {
    this.sectorSize = SECTOR_SIZE;
    this.totalSectors = totalSectors;
    this.disk = new Uint8Array(totalSectors * SECTOR_SIZE);
    this.bus = bus;

    this.status  = 0; // idle
    this.sector  = 0;
    this.dmaAddr = 0;
  }

  /** Attach to a bus at BLOCK_BASE. */
  attach(bus) {
    this.bus = bus;
    bus.mapDevice(BLOCK_BASE, BLK_SIZE, this);
  }

  read32(addr) {
    const off = (addr >>> 0) - (BLOCK_BASE >>> 0);
    switch (off) {
      case BLK_STATUS:    return this.status;
      case BLK_SECTOR:    return this.sector;
      case BLK_DMA_ADDR:  return this.dmaAddr;
      case BLK_CAPACITY:  return this.totalSectors;
      case BLK_SECT_SIZE: return this.sectorSize;
      default: return 0;
    }
  }

  write32(addr, v) {
    const off = (addr >>> 0) - (BLOCK_BASE >>> 0);
    switch (off) {
      case BLK_SECTOR:   this.sector = v >>> 0; break;
      case BLK_DMA_ADDR: this.dmaAddr = v >>> 0; break;
      case BLK_COMMAND:  this._exec(v | 0); break;
      default: break;
    }
  }

  _exec(cmd) {
    if (this.sector >= this.totalSectors) {
      this.status = 3; // error
      return;
    }
    const diskOff = this.sector * SECTOR_SIZE;
    const pa = this.dmaAddr >>> 0;
    if (cmd === BLK_CMD_READ) {
      // DMA from disk → guest RAM
      this.status = 1; // busy
      for (let i = 0; i < SECTOR_SIZE; i++) {
        this.bus.write8(pa + i, this.disk[diskOff + i]);
      }
      this.status = 2; // done-ok
    } else if (cmd === BLK_CMD_WRITE) {
      // DMA from guest RAM → disk
      this.status = 1;
      for (let i = 0; i < SECTOR_SIZE; i++) {
        this.disk[diskOff + i] = this.bus.read8(pa + i);
      }
      this.status = 2;
    } else {
      this.status = 3; // error: unknown command
    }
  }
}

// ─── BrowGPU Virtual Graphics & Compute Accelerator ───────────────────────────

const GPU_SIZE = 0x100; // 256-byte register window

class BrowGpu {
  /**
   * @param {Bus} bus Reference to system bus.
   * @param {object} [opts]
   * @param {number} [opts.width] Default 320
   * @param {number} [opts.height] Default 240
   * @param {function(Uint32Array, number, number):void} [opts.onPresent] Callback on frame present.
   */
  constructor(bus, opts = {}) {
    this.bus = bus;
    this.fbWidth = opts.width || 320;
    this.fbHeight = opts.height || 240;
    this.onPresent = opts.onPresent || null;

    this.magic = GPU_MAGIC;
    this.version = GPU_VERSION;
    this.status = 1; // ready
    this.fbAddr = 0;
    this.cmdAddr = 0;
    this.cmdLen = 0;
    this.backend = 0; // 0 = Software/Wasm CPU, 1 = WebGL2, 2 = WebGPU
    this.presentCount = 0;

    this.framebuffer = new Uint32Array(this.fbWidth * this.fbHeight);
  }

  attach(bus) {
    this.bus = bus;
    bus.mapDevice(GPU_CTRL_BASE, GPU_SIZE, this);
  }

  read32(addr) {
    const off = (addr >>> 0) - (GPU_CTRL_BASE >>> 0);
    switch (off) {
      case GPU_REG_MAGIC:     return this.magic;
      case GPU_REG_VERSION:   return this.version;
      case GPU_REG_STATUS:    return this.status;
      case GPU_REG_FB_WIDTH:  return this.fbWidth;
      case GPU_REG_FB_HEIGHT: return this.fbHeight;
      case GPU_REG_FB_ADDR:   return this.fbAddr;
      case GPU_REG_CMD_ADDR:  return this.cmdAddr;
      case GPU_REG_CMD_LEN:   return this.cmdLen;
      case GPU_REG_BACKEND:   return this.backend;
      default: return 0;
    }
  }

  write32(addr, val) {
    const off = (addr >>> 0) - (GPU_CTRL_BASE >>> 0);
    switch (off) {
      case GPU_REG_FB_WIDTH:
        this.fbWidth = val >>> 0;
        this._resizeFb();
        break;
      case GPU_REG_FB_HEIGHT:
        this.fbHeight = val >>> 0;
        this._resizeFb();
        break;
      case GPU_REG_FB_ADDR:  this.fbAddr = val >>> 0; break;
      case GPU_REG_CMD_ADDR: this.cmdAddr = val >>> 0; break;
      case GPU_REG_CMD_LEN:  this.cmdLen = val >>> 0; break;
      case GPU_REG_SUBMIT:   if ((val | 0) === 1) this._execCommandBuffer(); break;
      case GPU_REG_PRESENT:  if ((val | 0) === 1) this._present(); break;
      case GPU_REG_BACKEND:  this.backend = val & 3; break;
      default: break;
    }
  }

  _resizeFb() {
    const sz = this.fbWidth * this.fbHeight;
    if (this.framebuffer.length !== sz) {
      this.framebuffer = new Uint32Array(sz);
    }
  }

  _present() {
    this.presentCount++;
    if (this.fbAddr !== 0 && this.bus) {
      // Sync guest RAM framebuffer from GPU framebuffer if needed
      const pa = this.fbAddr >>> 0;
      const count = Math.min(this.framebuffer.length, 320 * 240);
      for (let i = 0; i < count; i++) {
        this.bus.write32(pa + i * 4, this.framebuffer[i]);
      }
    }
    if (this.onPresent) {
      this.onPresent(this.framebuffer, this.fbWidth, this.fbHeight);
    }
  }

  _execCommandBuffer() {
    if (!this.bus || this.cmdLen < 4) return;
    this.status = 2; // busy

    const pa = this.cmdAddr >>> 0;
    let offset = 0;
    const numWords = Math.floor(this.cmdLen / 4);

    while (offset < numWords) {
      const op = this.bus.read32(pa + offset * 4) >>> 0;
      offset++;

      if (op === CMD_CLEAR) {
        const color = this.bus.read32(pa + offset * 4) >>> 0;
        offset++;
        this.framebuffer.fill(color);
      } else if (op === CMD_DRAW_RECT) {
        const x = this.bus.read32(pa + offset * 4) | 0;
        const y = this.bus.read32(pa + (offset + 1) * 4) | 0;
        const w = this.bus.read32(pa + (offset + 2) * 4) | 0;
        const h = this.bus.read32(pa + (offset + 3) * 4) | 0;
        const color = this.bus.read32(pa + (offset + 4) * 4) >>> 0;
        offset += 5;
        this._drawRect(x, y, w, h, color);
      } else if (op === CMD_BLIT) {
        const srcPa = this.bus.read32(pa + offset * 4) >>> 0;
        const x = this.bus.read32(pa + (offset + 1) * 4) | 0;
        const y = this.bus.read32(pa + (offset + 2) * 4) | 0;
        const w = this.bus.read32(pa + (offset + 3) * 4) | 0;
        const h = this.bus.read32(pa + (offset + 4) * 4) | 0;
        offset += 5;
        this._blit(srcPa, x, y, w, h);
      } else if (op === CMD_DISPATCH_COMPUTE) {
        const kernelId = this.bus.read32(pa + offset * 4) >>> 0;
        const p1 = this.bus.read32(pa + (offset + 1) * 4) | 0;
        const p2 = this.bus.read32(pa + (offset + 2) * 4) | 0;
        const p3 = this.bus.read32(pa + (offset + 3) * 4) | 0;
        offset += 4;
        this._dispatchCompute(kernelId, p1, p2, p3);
      } else if (op === CMD_PRESENT) {
        this._present();
      } else {
        break; // unknown opcode
      }
    }

    this.status = 1; // ready
  }

  _drawRect(rx, ry, rw, rh, color) {
    const x0 = Math.max(0, rx);
    const y0 = Math.max(0, ry);
    const x1 = Math.min(this.fbWidth, rx + rw);
    const y1 = Math.min(this.fbHeight, ry + rh);

    for (let y = y0; y < y1; y++) {
      const row = y * this.fbWidth;
      for (let x = x0; x < x1; x++) {
        this.framebuffer[row + x] = color;
      }
    }
  }

  _blit(srcPa, dstX, dstY, w, h) {
    for (let y = 0; y < h; y++) {
      const fy = dstY + y;
      if (fy < 0 || fy >= this.fbHeight) continue;
      const row = fy * this.fbWidth;
      for (let x = 0; x < w; x++) {
        const fx = dstX + x;
        if (fx < 0 || fx >= this.fbWidth) continue;
        const pixel = this.bus.read32(srcPa + (y * w + x) * 4) >>> 0;
        this.framebuffer[row + fx] = pixel;
      }
    }
  }

  _dispatchCompute(kernelId, p1, p2, p3) {
    if (kernelId === 1) {
      // Ray-traced 3D Earth Globe
      this._raytraceGlobe(p1);
    } else if (kernelId === 2) {
      // Mandelbrot fractal
      this._mandelbrot(p1, p2, p3);
    }
  }

  _raytraceGlobe(timeVal) {
    const w = this.fbWidth;
    const h = this.fbHeight;
    const time = (timeVal || 0) * 0.05;

    // Light source direction
    const lx = 0.65, ly = 0.55, lz = -0.52;
    const lLen = Math.hypot(lx, ly, lz);
    const nlx = lx / lLen, nly = ly / lLen, nlz = lz / lLen;

    const rSphere = 0.85;

    for (let y = 0; y < h; y++) {
      const v = (1.0 - 2.0 * (y / h)) * (h / w);
      const row = y * w;

      for (let x = 0; x < w; x++) {
        const u = 2.0 * (x / w) - 1.0;
        const r2 = u * u + v * v;

        if (r2 <= rSphere * rSphere) {
          // Ray hits 3D sphere
          const nz = Math.sqrt(rSphere * rSphere - r2) / rSphere;
          const nx = u / rSphere;
          const ny = v / rSphere;

          // Diffuse lighting
          const diff = Math.max(0, nx * nlx + ny * nly + nz * nlz);

          // Specular highlight
          const hx = nlx, hy = nly, hz = nlz + 1.0;
          const hLen = Math.hypot(hx, hy, hz);
          const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hLen), 16) * 0.45;

          // Atmospheric Fresnel rim glow
          const fresnel = Math.pow(1.0 - nz, 3.0) * 0.7;

          // Latitude and rotating longitude
          const lat = Math.asin(Math.max(-1, Math.min(1, ny)));
          const lon = Math.atan2(nz, nx) + time;

          // Procedural Earth surface (continents vs ocean)
          const landPattern = Math.sin(lat * 7.0) * Math.cos(lon * 7.0) +
                              Math.sin(lat * 14.0 + lon * 5.0) * 0.35;
          const isLand = landPattern > 0.08;

          let r, g, b;
          if (isLand) {
            // Continental vegetation / terrain green-brown
            r = Math.floor((34 + 60 * diff) * (0.3 + 0.7 * diff));
            g = Math.floor((120 + 70 * diff) * (0.3 + 0.7 * diff));
            b = Math.floor((40 + 30 * diff) * (0.3 + 0.7 * diff));
          } else {
            // Deep ocean blue with specular reflection
            r = Math.floor(12 * diff + spec * 220);
            g = Math.floor(45 * diff + spec * 220);
            b = Math.floor(160 * diff + spec * 255);
          }

          // Blend atmosphere rim blue
          r = Math.min(255, Math.floor(r + fresnel * 70));
          g = Math.min(255, Math.floor(g + fresnel * 140));
          b = Math.min(255, Math.floor(b + fresnel * 255));

          // RGBA32: A=255, B, G, R (0xAABBGGRR)
          this.framebuffer[row + x] = 0xFF000000 | (b << 16) | (g << 8) | r;
        } else {
          // Space background with atmospheric outer glow halo
          const d = Math.sqrt(r2) - rSphere;
          const glow = Math.exp(-Math.max(0, d) * 12.0) * 0.45;
          const gb = Math.floor(glow * 255);
          const gg = Math.floor(glow * 120);
          this.framebuffer[row + x] = 0xFF000000 | (gb << 16) | (gg << 8);
        }
      }
    }
  }

  _mandelbrot(zoomVal, cxVal, cyVal) {
    const w = this.fbWidth;
    const h = this.fbHeight;
    const zoom = (zoomVal || 1000) / 1000.0;
    const cx = (cxVal || 0) / 1000.0 - 0.7;
    const cy = (cyVal || 0) / 1000.0;
    const maxIter = 40;

    for (let y = 0; y < h; y++) {
      const y0 = ((y - h / 2) / (h / 2)) / zoom + cy;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const x0 = ((x - w / 2) / (h / 2)) / zoom + cx;
        let zx = 0, zy = 0, iter = 0;
        while (zx * zx + zy * zy <= 4 && iter < maxIter) {
          const tmp = zx * zx - zy * zy + x0;
          zy = 2 * zx * zy + y0;
          zx = tmp;
          iter++;
        }
        if (iter === maxIter) {
          this.framebuffer[row + x] = 0xFF000000;
        } else {
          const c = Math.floor((iter / maxIter) * 255);
          this.framebuffer[row + x] = 0xFF000000 | (c << 16) | ((c >> 1) << 8) | (c >> 2);
        }
      }
    }
  }
}

module.exports = {
  Uart, UART_SIZE,
  BlockDevice, BLK_SIZE, SECTOR_SIZE,
  BrowGpu, GPU_SIZE,
  // Register offset constants (useful for tests)
  UART_RBR, UART_THR, UART_IER, UART_IIR, UART_FCR,
  UART_LCR, UART_MCR, UART_LSR, UART_MSR, UART_SCR,
  LSR_DATA_READY, LSR_TX_EMPTY, LSR_TX_IDLE,
  BLK_STATUS, BLK_COMMAND, BLK_SECTOR, BLK_DMA_ADDR,
  BLK_CAPACITY, BLK_SECT_SIZE,
  BLK_CMD_READ, BLK_CMD_WRITE,
  GPU_REG_MAGIC, GPU_REG_VERSION, GPU_REG_STATUS,
  GPU_REG_FB_WIDTH, GPU_REG_FB_HEIGHT, GPU_REG_FB_ADDR,
  GPU_REG_CMD_ADDR, GPU_REG_CMD_LEN, GPU_REG_SUBMIT,
  GPU_REG_PRESENT, GPU_REG_BACKEND,
  GPU_MAGIC, GPU_VERSION,
  CMD_CLEAR, CMD_DRAW_RECT, CMD_BLIT, CMD_DISPATCH_COMPUTE, CMD_PRESENT,
};
