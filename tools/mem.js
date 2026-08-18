'use strict';

class Bus {
  constructor(size = 16 * 1024 * 1024, offset = 0) {
    this.data = new Uint8Array(size);
    this.offset = offset;
    this.devices = [];
  }

  get size() {
    return this.data.length;
  }

  mapDevice(base, size, io) {
    this.devices.push({ base: base >>> 0, size, io });
  }

  findDevice(addr, len) {
    const a = addr >>> 0;
    for (const d of this.devices) {
      if (a >= d.base && a + len <= d.base + d.size) return d;
    }
    return null;
  }

  check(addr, len) {
    const p = (addr >>> 0) - (this.offset >>> 0);
    if (p < 0 || p + len > this.data.length) {
      throw new RangeError(
        'Bus access out of bounds: addr=0x' + (addr >>> 0).toString(16) +
        ' len=' + len + ' size=0x' + this.data.length.toString(16)
      );
    }
  }

  read8(addr) {
    this.check(addr, 1);
    return this.data[(addr >>> 0) - (this.offset >>> 0)];
  }

  read16(addr) {
    this.check(addr, 2);
    const d = this.data;
    const p = (addr >>> 0) - (this.offset >>> 0);
    return d[p] | (d[p + 1] << 8);
  }

  read32(addr) {
    const d = this.findDevice(addr, 4);
    if (d) return d.io.read32(addr) | 0;
    this.check(addr, 4);
    const b = this.data;
    const p = (addr >>> 0) - (this.offset >>> 0);
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) | 0;
  }

  write8(addr, v) {
    this.check(addr, 1);
    this.data[(addr >>> 0) - (this.offset >>> 0)] = v & 0xFF;
  }

  write16(addr, v) {
    this.check(addr, 2);
    const d = this.data;
    const p = (addr >>> 0) - (this.offset >>> 0);
    d[p] = v & 0xFF;
    d[p + 1] = (v >>> 8) & 0xFF;
  }

  write32(addr, v) {
    const d = this.findDevice(addr, 4);
    if (d) { d.io.write32(addr, v | 0); return; }
    this.check(addr, 4);
    const b = this.data;
    const p = (addr >>> 0) - (this.offset >>> 0);
    b[p] = v & 0xFF;
    b[p + 1] = (v >>> 8) & 0xFF;
    b[p + 2] = (v >>> 16) & 0xFF;
    b[p + 3] = (v >>> 24) & 0xFF;
  }

  load(addr, bytes) {
    this.check(addr, bytes.length);
    this.data.set(bytes, (addr >>> 0) - (this.offset >>> 0));
  }

  zero(addr, len) {
    this.check(addr, len);
    const p = (addr >>> 0) - (this.offset >>> 0);
    this.data.fill(0, p, p + len);
  }

  dump(addr, len) {
    this.check(addr, len);
    const p = (addr >>> 0) - (this.offset >>> 0);
    return Array.from(this.data.subarray(p, p + len));
  }
}

class Clint {
  constructor() {
    this.msip = 0;
    this.mtimeLo = 0;
    this.mtimeHi = 0;
    this.mtimecmpLo = 0xFFFFFFFF;
    this.mtimecmpHi = 0xFFFFFFFF;
  }

  attach(bus) {
    bus.mapDevice(0x02000000, 4, {
      read32: () => this.msip,
      write32: (addr, v) => { this.msip = v & 1; },
    });
    bus.mapDevice(0x02004000, 8, {
      read32: (addr) => (addr & 4) ? this.mtimecmpHi : this.mtimecmpLo,
      write32: (addr, v) => {
        if (addr & 4) this.mtimecmpHi = v >>> 0;
        else this.mtimecmpLo = v >>> 0;
      },
    });
    bus.mapDevice(0x0200BFF8, 8, {
      read32: (addr) => (addr & 4) ? this.mtimeHi : this.mtimeLo,
      write32: () => {},
    });
  }

  tick() {
    this.mtimeLo = (this.mtimeLo + 1) >>> 0;
    if (this.mtimeLo === 0) this.mtimeHi = (this.mtimeHi + 1) >>> 0;
  }

  get msipSet() {
    return this.msip !== 0;
  }

  get mtimeFired() {
    return this.mtimeHi > this.mtimecmpHi ||
           (this.mtimeHi === this.mtimecmpHi && this.mtimeLo >= this.mtimecmpLo);
  }
}

module.exports = { Bus, Clint };
