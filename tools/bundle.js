'use strict';

/**
 * bundle.js — Single-File HTML Distribution Bundler for BrowOS.
 * Assembles kernel, userland binaries, disk image, and VM engine into a standalone index.html.
 */

const fs = require('fs');
const path = require('path');
const { assemble } = require('./asm.js');
const { formatDisk } = require('./mkfs.js');

const ROOT_DIR = path.join(__dirname, '..');
const KERNEL_DIR = path.join(ROOT_DIR, 'kernel');
const USER_DIR = path.join(ROOT_DIR, 'user');
const TOOLS_DIR = path.join(ROOT_DIR, 'tools');
const WEB_DIR = path.join(ROOT_DIR, 'web');

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

function buildKernelElf() {
  const src = KERNEL_PARTS
    .map((f) => fs.readFileSync(path.join(KERNEL_DIR, f), 'utf8'))
    .join('\n');
  return assemble(src);
}

function buildUserProgram(assemblySrc) {
  const libSrc = fs.readFileSync(path.join(USER_DIR, 'libbrow.s'), 'utf8');
  return assemble(libSrc + '\n' + assemblySrc, { base: 0x40000000 });
}

function bundle() {
  console.log('[BrowOS] Assembling Kernel...');
  const kernelElf = buildKernelElf();
  console.log(`[BrowOS] Kernel assembled (${kernelElf.bytes.length} bytes).`);

  console.log('[BrowOS] Assembling Userland /sh shell...');
  const shSrc = fs.readFileSync(path.join(USER_DIR, 'sh.s'), 'utf8');
  const shElf = buildUserProgram(shSrc);

  console.log('[BrowOS] Assembling Userland /globe raytracer...');
  const globeSrc = fs.readFileSync(path.join(USER_DIR, 'globe.s'), 'utf8');
  const globeElf = buildUserProgram(globeSrc);

  console.log('[BrowOS] Formatting BrFS root disk image...');
  const readmeContent = new TextEncoder().encode(
    'Welcome to BrowOS 0.1.0!\n\n' +
    'Type "help" for a list of shell commands.\n' +
    'Type "globe" to compute and render the 3D raytraced Earth on BrowGPU.\n' +
    'Type "uname" to view system architecture.\n' +
    'Type "ps" to view active processes.\n'
  );

  const diskBytes = formatDisk(2048, [
    { path: 'sh', content: shElf.bytes },
    { path: 'globe', content: globeElf.bytes },
    { path: 'README.txt', content: readmeContent },
  ]);
  console.log(`[BrowOS] Disk formatted (${diskBytes.length} bytes).`);

  const kernelB64 = Buffer.from(kernelElf.bytes).toString('base64');
  const diskB64 = Buffer.from(diskBytes).toString('base64');

  // Read stylesheets and client scripts
  const css = fs.readFileSync(path.join(WEB_DIR, 'style.css'), 'utf8');

  // Strip CommonJS exports / requires for browser compatibility
  function stripNodeCode(code) {
    return code
      .replace(/const\s+\{.*\}\s*=\s*require\(.*\);?/g, '')
      .replace(/const\s+\w+\s*=\s*require\(.*\);?/g, '')
      .replace(/module\.exports\s*=\s*\{[\s\S]*?\};?/g, '')
      .replace(/if\s*\(typeof module[\s\S]*?\}\s*\}/g, '');
  }

  const memmapJs = stripNodeCode(fs.readFileSync(path.join(TOOLS_DIR, 'memmap.js'), 'utf8'));
  const memJs = stripNodeCode(fs.readFileSync(path.join(TOOLS_DIR, 'mem.js'), 'utf8'));
  const cpuJs = stripNodeCode(fs.readFileSync(path.join(TOOLS_DIR, 'cpu.js'), 'utf8'));
  const devicesJs = stripNodeCode(fs.readFileSync(path.join(TOOLS_DIR, 'devices.js'), 'utf8'));
  const elfJs = stripNodeCode(fs.readFileSync(path.join(TOOLS_DIR, 'elf.js'), 'utf8'));
  const terminalJs = stripNodeCode(fs.readFileSync(path.join(WEB_DIR, 'terminal.js'), 'utf8'));
  const appJs = stripNodeCode(fs.readFileSync(path.join(WEB_DIR, 'app.js'), 'utf8'));

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BrowOS — Self-Contained RISC-V Web Operating System</title>
  <style>
${css}
  </style>
</head>
<body>
  <header>
    <div class="logo-container">
      <div class="logo-text">BrowOS</div>
      <div class="badge">RV32IM / Sv32</div>
    </div>
    <div class="header-stats">
      <div class="stat-item">
        <div class="led led-green" id="led-power"></div>
        <span>PWR</span>
      </div>
      <div class="stat-item">
        <div class="led" id="led-gpu"></div>
        <span>GPU</span>
      </div>
      <div class="stat-item">
        <span>Mode:</span>
        <span class="stat-val" id="stat-priv">M-Mode</span>
      </div>
      <div class="stat-item">
        <span>MIPS:</span>
        <span class="stat-val" id="stat-mips">0.00</span>
      </div>
    </div>
  </header>

  <main>
    <!-- Terminal Panel -->
    <div class="panel">
      <div class="panel-header">
        <span>Interactive ANSI Terminal (UART0)</span>
        <div class="panel-controls">
          <button class="btn-ctrl" id="btn-reset">Reboot</button>
          <button class="btn-ctrl" id="btn-pause">Pause</button>
        </div>
      </div>
      <div class="terminal-container">
        <canvas id="term-canvas" tabindex="0"></canvas>
      </div>
    </div>

    <!-- Sidebar: GPU & Hardware Telemetry -->
    <div class="sidebar">
      <!-- BrowGPU Hardware Display -->
      <div class="panel">
        <div class="panel-header">
          <span>BrowGPU Framebuffer</span>
          <span class="badge">320x240</span>
        </div>
        <div class="gpu-container">
          <canvas id="gpu-canvas" width="320" height="240"></canvas>
        </div>
      </div>

      <!-- Quick Command Buttons -->
      <div class="panel">
        <div class="panel-header">
          <span>Quick Actions</span>
        </div>
        <div class="action-grid">
          <button class="btn-action" id="btn-globe">Render Globe</button>
          <button class="btn-action" id="btn-ps">Process List</button>
          <button class="btn-action" id="btn-uname">System Info</button>
          <button class="btn-action" id="btn-help">Help</button>
        </div>
      </div>

      <!-- System Telemetry -->
      <div class="panel">
        <div class="panel-header">
          <span>Hardware Telemetry</span>
        </div>
        <div class="telemetry-grid">
          <div class="telemetry-card">
            <div class="telemetry-label">Program Counter</div>
            <div class="telemetry-value" id="stat-pc">0x00000000</div>
          </div>
          <div class="telemetry-card">
            <div class="telemetry-label">Instructions</div>
            <div class="telemetry-value" id="stat-inst">0.0k</div>
          </div>
          <div class="telemetry-card">
            <div class="telemetry-label">RAM Allocation</div>
            <div class="telemetry-value">256 MiB</div>
          </div>
          <div class="telemetry-card">
            <div class="telemetry-label">BrFS Root Disk</div>
            <div class="telemetry-value">1024 KiB</div>
          </div>
        </div>
      </div>
    </div>
  </main>

  <footer>
    <span>BrowOS 0.1.0 — 100% Client-Side Pure WebAssembly/JavaScript OS Simulation</span>
    <span>Zero Backend Required &bull; RISC-V RV32IM &bull; Sv32 MMU &bull; BrowGPU</span>
  </footer>

  <script>
    // Embedded Binary Assets
    const BROWOS_KERNEL_ELF = Uint8Array.from(atob("${kernelB64}"), c => c.charCodeAt(0));
    const BROWOS_DISK_IMG = Uint8Array.from(atob("${diskB64}"), c => c.charCodeAt(0));
    window.BROWOS_KERNEL_ELF = BROWOS_KERNEL_ELF;
    window.BROWOS_DISK_IMG = BROWOS_DISK_IMG;

    // Inlined Virtual Machine Modules
${memmapJs}
${memJs}
${cpuJs}
${devicesJs}
${elfJs}
${terminalJs}
${appJs}
  </script>
</body>
</html>`;

  const outPath = path.join(ROOT_DIR, 'index.html');
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`[BrowOS] Successfully bundled standalone index.html (${html.length} bytes)!`);
  return { htmlPath: outPath, size: html.length };
}

if (require.main === module) {
  bundle();
}

module.exports = { bundle };
