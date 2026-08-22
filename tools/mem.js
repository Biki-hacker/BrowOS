'use strict';

class Bus {
  constructor(size = 16 * 1024 * 1024, offset = 0) {
    this.data = new Uint8Array(size);
    this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    this.offset = offset;
    this.devices = [];
    this.minDevAddr = 0xFFFFFFFF;
    this.maxDevAddr = 0;
  }

  get size() {
    return this.data.length;
  }

  mapDevice(base, size, io) {
    const b = base >>> 0;
    this.devices.push({ base: b, size, io });
    if (b < this.minDevAddr) this.minDevAddr = b;
    const end = (b + size) >>> 0;
    if (end > this.maxDevAddr) this.maxDevAddr = end;
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
    const a = addr >>> 0;
    if (this.devices.length !== 0 && a >= this.minDevAddr && a <= this.maxDevAddr) {
      const d = this.findDevice(a, 1);
      if (d) return d.io.read8 ? d.io.read8(a) : ((d.io.read32(a & ~3) >>> ((a & 3) * 8)) & 0xFF);
    }
    this.check(a, 1);
    return this.data[a - (this.offset >>> 0)];
  }

  read16(addr) {
    const a = addr >>> 0;
    if (this.devices.length !== 0 && a >= this.minDevAddr && a <= this.maxDevAddr) {
      const dev = this.findDevice(a, 2);
      if (dev) return dev.io.read16 ? dev.io.read16(a) : ((dev.io.read32(a & ~3) >>> ((a & 2) * 8)) & 0xFFFF);
    }
    this.check(a, 2);
    return this.view.getUint16(a - (this.offset >>> 0), true);
  }

  read32(addr) {
    const a = addr >>> 0;
    if (this.devices.length !== 0 && a >= this.minDevAddr && a <= this.maxDevAddr) {
      const d = this.findDevice(a, 4);
      if (d) return d.io.read32(a) | 0;
    }
    this.check(a, 4);
    return this.view.getInt32(a - (this.offset >>> 0), true);
  }

  write8(addr, v) {
    const a = addr >>> 0;
    if (this.devices.length !== 0 && a >= this.minDevAddr && a <= this.maxDevAddr) {
      const d = this.findDevice(a, 1);
      if (d) { if (d.io.write8) d.io.write8(a, v); return; }
    }
    this.check(a, 1);
    this.data[a - (this.offset >>> 0)] = v & 0xFF;
  }

  write16(addr, v) {
    const a = addr >>> 0;
    if (this.devices.length !== 0 && a >= this.minDevAddr && a <= this.maxDevAddr) {
      const dev = this.findDevice(a, 2);
      if (dev) { if (dev.io.write16) dev.io.write16(a, v); return; }
    }
    this.check(a, 2);
    this.view.setUint16(a - (this.offset >>> 0), v & 0xFFFF, true);
  }

  write32(addr, v) {
    const a = addr >>> 0;
    if (this.devices.length !== 0 && a >= this.minDevAddr && a <= this.maxDevAddr) {
      const d = this.findDevice(a, 4);
      if (d) { d.io.write32(a, v | 0); return; }
    }
    this.check(a, 4);
    this.view.setInt32(a - (this.offset >>> 0), v | 0, true);
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
