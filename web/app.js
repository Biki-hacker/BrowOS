'use strict';

/**
 * app.js — BrowOS Browser Host Controller and VM Execution Manager.
 * Orchestrates CPU execution, hardware MMIO devices, terminal, GPU canvas, and telemetry dashboard.
 */

class BrowOsApp {
  constructor() {
    this.bus = null;
    this.cpu = null;
    this.uart = null;
    this.blk = null;
    this.gpu = null;
    this.terminal = null;

    this.running = false;
    this.animFrameId = null;
    this.instructionsPerBatch = 50000;

    this.lastTime = performance.now();
    this.lastInstCount = 0;
    this.mips = 0;

    // Initialize UI and Terminal
    this._initDom();
  }

  _initDom() {
    const termCanvas = document.getElementById('term-canvas');
    if (termCanvas) {
      this.terminal = new AnsiTerminal(termCanvas, {
        onKey: (byte) => {
          if (this.uart) this.uart.pushRx(byte);
        },
      });
    }

    // Connect control buttons
    const btnReset = document.getElementById('btn-reset');
    if (btnReset) btnReset.addEventListener('click', () => this.reset());

    const btnPause = document.getElementById('btn-pause');
    if (btnPause) {
      btnPause.addEventListener('click', () => {
        if (this.running) {
          this.pause();
          btnPause.innerText = 'Resume';
        } else {
          this.start();
          btnPause.innerText = 'Pause';
        }
      });
    }

    const btnGlobe = document.getElementById('btn-globe');
    if (btnGlobe) {
      btnGlobe.addEventListener('click', () => {
        // Send "globe\n" into UART
        this.sendInput('globe\n');
      });
    }

    const btnHelp = document.getElementById('btn-help');
    if (btnHelp) {
      btnHelp.addEventListener('click', () => {
        this.sendInput('help\n');
      });
    }

    const btnPs = document.getElementById('btn-ps');
    if (btnPs) {
      btnPs.addEventListener('click', () => {
        this.sendInput('ps\n');
      });
    }

    const btnUname = document.getElementById('btn-uname');
    if (btnUname) {
      btnUname.addEventListener('click', () => {
        this.sendInput('uname\n');
      });
    }
  }

  sendInput(str) {
    if (!this.uart) return;
    for (let i = 0; i < str.length; i++) {
      this.uart.pushRx(str.charCodeAt(i));
    }
  }

  /**
   * Boots BrowOS with embedded ELF bytes and disk image.
   * @param {Uint8Array} kernelElfBytes
   * @param {Uint8Array} diskImageBytes
   */
  boot(kernelElfBytes, diskImageBytes) {
    this.pause();

    const RAM_SIZE = 0x10000000; // 256 MiB
    this.bus = new Bus(RAM_SIZE, 0);

    const elf = readElf(kernelElfBytes);
    loadSegments(this.bus, kernelElfBytes, elf);

    // Attach UART
    this.uart = new Uart({
      onTx: (byte) => {
        if (this.terminal) {
          this.terminal.writeChar(String.fromCharCode(byte));
        }
      },
    });
    this.uart.attach(this.bus);

    // Attach Block Device (BrFS disk)
    const sectors = Math.max(2048, Math.ceil(diskImageBytes.length / 512));
    this.blk = new BlockDevice(sectors, this.bus);
    this.blk.disk.set(diskImageBytes);
    this.blk.attach(this.bus);

    // Attach BrowGPU
    const gpuCanvas = document.getElementById('gpu-canvas');
    this.gpu = new BrowGpu(this.bus, {
      width: 320,
      height: 240,
      onPresent: (fb, w, h) => {
        this._renderGpu(gpuCanvas, fb, w, h);
      },
    });
    this.gpu.attach(this.bus);

    // Initialize CPU at entry point
    this.cpu = new Cpu(this.bus, { pc: elf.entry });

    this.start();
  }

  _renderGpu(canvas, fb, w, h) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const imgData = ctx.createImageData(w, h);
    const data32 = new Uint32Array(imgData.data.buffer);
    data32.set(fb);
    ctx.putImageData(imgData, 0, 0);

    // Update GPU status indicator
    const ledGpu = document.getElementById('led-gpu');
    if (ledGpu) {
      ledGpu.classList.add('led-blue');
      setTimeout(() => ledGpu.classList.remove('led-blue'), 100);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.lastInstCount = this.cpu ? this.cpu.instCount : 0;
    this._loop();
  }

  pause() {
    this.running = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  reset() {
    if (window.BROWOS_KERNEL_ELF && window.BROWOS_DISK_IMG) {
      if (this.terminal) this.terminal.clear();
      this.boot(window.BROWOS_KERNEL_ELF, window.BROWOS_DISK_IMG);
    }
  }

  _loop() {
    if (!this.running || !this.cpu) return;

    const limit = this.cpu.instCount + this.instructionsPerBatch;
    while (this.cpu.instCount < limit && !this.cpu.halted) {
      this.cpu.step();
    }

    // Update telemetry once every frame
    this._updateTelemetry();

    // Re-render terminal buffer if pending updates
    if (this.terminal) this.terminal.render();

    this.animFrameId = requestAnimationFrame(() => this._loop());
  }

  _updateTelemetry() {
    const now = performance.now();
    const elapsed = (now - this.lastTime) / 1000;
    if (elapsed >= 0.5) {
      const instDiff = this.cpu.instCount - this.lastInstCount;
      this.mips = (instDiff / elapsed / 1000000).toFixed(2);
      this.lastTime = now;
      this.lastInstCount = this.cpu.instCount;

      const elMips = document.getElementById('stat-mips');
      if (elMips) elMips.innerText = this.mips;

      const elInst = document.getElementById('stat-inst');
      if (elInst) elInst.innerText = (this.cpu.instCount / 1000).toFixed(1) + 'k';

      const elPc = document.getElementById('stat-pc');
      if (elPc) elPc.innerText = '0x' + (this.cpu.pc >>> 0).toString(16).toUpperCase();

      const elPriv = document.getElementById('stat-priv');
      if (elPriv) {
        const mode = this.cpu.priv === 3 ? 'M-Mode' : this.cpu.priv === 1 ? 'S-Mode' : 'U-Mode';
        elPriv.innerText = mode;
      }
    }
  }
}

// Auto-start when DOM is ready
window.addEventListener('DOMContentLoaded', () => {
  window.browApp = new BrowOsApp();
  if (window.BROWOS_KERNEL_ELF && window.BROWOS_DISK_IMG) {
    window.browApp.boot(window.BROWOS_KERNEL_ELF, window.BROWOS_DISK_IMG);
  }
});
