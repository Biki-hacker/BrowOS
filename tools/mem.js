'use strict';

class Bus {
  constructor(size = 16 * 1024 * 1024) {
    this.data = new Uint8Array(size);
  }

  get size() {
    return this.data.length;
  }

  check(addr, len) {
    if (addr < 0 || addr + len > this.data.length) {
      throw new RangeError(
        'Bus access out of bounds: addr=0x' + (addr >>> 0).toString(16) +
        ' len=' + len + ' size=0x' + this.data.length.toString(16)
      );
    }
  }

  read8(addr) {
    this.check(addr, 1);
    return this.data[addr];
  }

  read16(addr) {
    this.check(addr, 2);
    const d = this.data;
    return d[addr] | (d[addr + 1] << 8);
  }

  read32(addr) {
    this.check(addr, 4);
    const d = this.data;
    return (d[addr] | (d[addr + 1] << 8) | (d[addr + 2] << 16) | (d[addr + 3] << 24)) | 0;
  }

  write8(addr, v) {
    this.check(addr, 1);
    this.data[addr] = v & 0xFF;
  }

  write16(addr, v) {
    this.check(addr, 2);
    const d = this.data;
    d[addr] = v & 0xFF;
    d[addr + 1] = (v >>> 8) & 0xFF;
  }

  write32(addr, v) {
    this.check(addr, 4);
    const d = this.data;
    d[addr] = v & 0xFF;
    d[addr + 1] = (v >>> 8) & 0xFF;
    d[addr + 2] = (v >>> 16) & 0xFF;
    d[addr + 3] = (v >>> 24) & 0xFF;
  }

  load(addr, bytes) {
    this.check(addr, bytes.length);
    this.data.set(bytes, addr);
  }

  dump(addr, len) {
    this.check(addr, len);
    return Array.from(this.data.subarray(addr, addr + len));
  }
}

module.exports = { Bus };
