'use strict';

class Bus {
  constructor(size = 16 * 1024 * 1024, offset = 0) {
    this.data = new Uint8Array(size);
    this.offset = offset;
  }

  get size() {
    return this.data.length;
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
    this.check(addr, 4);
    const d = this.data;
    const p = (addr >>> 0) - (this.offset >>> 0);
    return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) | 0;
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
    this.check(addr, 4);
    const d = this.data;
    const p = (addr >>> 0) - (this.offset >>> 0);
    d[p] = v & 0xFF;
    d[p + 1] = (v >>> 8) & 0xFF;
    d[p + 2] = (v >>> 16) & 0xFF;
    d[p + 3] = (v >>> 24) & 0xFF;
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

module.exports = { Bus };
