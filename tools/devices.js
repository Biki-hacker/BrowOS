'use strict';

/**
 * devices.js — Virtual hardware devices for BrowOS.
 *
 * Each device is an object with read8/write8 (and optionally read32/write32)
 * methods keyed to their MMIO address range.
 */

const { UART_BASE, BLOCK_BASE } = require('./memmap.js');

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

module.exports = {
  Uart, UART_SIZE,
  BlockDevice, BLK_SIZE, SECTOR_SIZE,
  // Register offset constants (useful for tests)
  UART_RBR, UART_THR, UART_IER, UART_IIR, UART_FCR,
  UART_LCR, UART_MCR, UART_LSR, UART_MSR, UART_SCR,
  LSR_DATA_READY, LSR_TX_EMPTY, LSR_TX_IDLE,
  BLK_STATUS, BLK_COMMAND, BLK_SECTOR, BLK_DMA_ADDR,
  BLK_CAPACITY, BLK_SECT_SIZE,
  BLK_CMD_READ, BLK_CMD_WRITE,
};
