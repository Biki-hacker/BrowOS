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
      .replace(/const\s+[\s\S]*?=\s*require\([^\)]*\);?/g, '')
      .replace(/let\s+[\s\S]*?=\s*require\([^\)]*\);?/g, '')
      .replace(/var\s+[\s\S]*?=\s*require\([^\)]*\);?/g, '')
      .replace(/module\.exports\s*=\s*[\s\S]*?;/g, '')
      .replace(/if\s*\(typeof module[\s\S]*?\}\s*\}/g, '')
      .replace(/'use strict';?/g, '');
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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0%25' y1='0%25' x2='100%25' y2='100%25'%3E%3Cstop offset='0%25' stop-color='%2300ff88'/%3E%3Cstop offset='100%25' stop-color='%2300d2ff'/%3E%3C/linearGradient%3E%3Cfilter id='glow'%3E%3CfeDropShadow dx='0' dy='0' stdDeviation='1.5' flood-color='%2300ff88' flood-opacity='0.6'/%3E%3C/filter%3E%3C/defs%3E%3Crect width='64' height='64' rx='14' fill='%23080a0f' stroke='url(%23g)' stroke-width='2.5'/%3E%3Cpath d='M20 18 h14 c6 0 11 3.5 11 8.5 0 3.2 -2.2 6 -5.8 7.3 4.6 1.4 7.8 4.6 7.8 8.7 0 5.5 -5 9.5 -12.5 9.5 H20 Z' fill='none' stroke='url(%23g)' stroke-width='4.5' stroke-linejoin='round' stroke-linecap='round' filter='url(%23glow)'/%3E%3Cpath d='M20 34 h13' stroke='url(%23g)' stroke-width='4.5' stroke-linecap='round'/%3E%3Ccircle cx='12' cy='32' r='2' fill='%2300ff88'/%3E%3Ccircle cx='52' cy='32' r='2' fill='%2300d2ff'/%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,700;1,400&family=Orbitron:wght@600;800&display=swap" rel="stylesheet">
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
        <span class="stat-val stat-priv-m" id="stat-priv">M-Mode</span>
      </div>
      <div class="stat-item">
        <span>MIPS:</span>
        <span class="stat-val" id="stat-mips">0.00</span>
      </div>
    </div>
  </header>

  <main>
    <!-- Terminal Panel -->
    <div class="panel terminal-panel">
      <div class="panel-header">
        <div class="panel-title-wrap">
          <span class="panel-icon">⬢</span>
          <span>Interactive ANSI Terminal (UART0)</span>
          <span class="badge badge-focus" id="badge-focus">Ready</span>
        </div>
        <div class="panel-controls">
          <button class="btn-ctrl" id="btn-reset" title="Reboot Virtual Machine">Reboot</button>
          <button class="btn-ctrl" id="btn-pause" title="Pause / Resume Execution">Pause</button>
        </div>
      </div>
      <div class="terminal-container" id="term-container" title="Click to focus console">
        <div class="terminal-screen-wrapper">
          <canvas id="term-canvas" tabindex="0"></canvas>
        </div>
      </div>
    </div>

    <!-- Sidebar: GPU & Hardware Telemetry -->
    <div class="sidebar">
      <!-- BrowGPU Hardware Display -->
      <div class="panel gpu-panel">
        <div class="panel-header">
          <div class="panel-title-wrap">
            <span class="panel-icon">✦</span>
            <span>BrowGPU Framebuffer</span>
          </div>
          <span class="badge">320x240 RGB32</span>
        </div>
        <div class="gpu-container">
          <canvas id="gpu-canvas" width="320" height="240"></canvas>
        </div>
      </div>

      <!-- Quick Command Buttons -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title-wrap">
            <span class="panel-icon">⚡</span>
            <span>Quick Console Actions</span>
          </div>
        </div>
        <div class="action-grid">
          <button class="btn-action" id="btn-globe"><span class="btn-icon">🌐</span> Globe</button>
          <button class="btn-action" id="btn-ps"><span class="btn-icon">📊</span> Processes</button>
          <button class="btn-action" id="btn-ls"><span class="btn-icon">📁</span> Files (ls)</button>
          <button class="btn-action" id="btn-uname"><span class="btn-icon">ℹ</span> System</button>
          <button class="btn-action" id="btn-clear"><span class="btn-icon">⌫</span> Clear</button>
          <button class="btn-action" id="btn-help"><span class="btn-icon">❓</span> Help</button>
        </div>
      </div>

      <!-- System Telemetry -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title-wrap">
            <span class="panel-icon">📡</span>
            <span>Hardware Telemetry</span>
          </div>
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
    <div class="footer-left">
      <span class="footer-brand">BrowOS 0.1.0</span> &bull; <span>100% Client-Side Pure WebAssembly / JS RISC-V Computer</span>
    </div>
    <div class="footer-right">
      <span>RV32IM</span> &bull; <span>Sv32 MMU</span> &bull; <span>BrowGPU</span> &bull; <span>BrFS</span>
    </div>
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

  // Mirror to public/ and dist/ directories for universal hosting compatibility
  const publicDir = path.join(ROOT_DIR, 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), html, 'utf8');

  const distDir = path.join(ROOT_DIR, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), html, 'utf8');

  console.log(`[BrowOS] Successfully bundled standalone index.html (${html.length} bytes)!`);
  return { htmlPath: outPath, size: html.length };
}

if (require.main === module) {
  bundle();
}

module.exports = { bundle };
