# BrowOS

> **A complete, living virtual computer running inside a single static HTML file.**

BrowOS is an operating system and a full computer architecture built to run entirely in your web browser. There are no server backends, no containers, and no hidden dependencies. Everything—from the CPU silicon simulation and memory management unit (MMU) up to the multitasking kernel, filesystem, shell, and graphics accelerator—is compiled into a standalone `index.html` file that you can double-click and run offline.

---

## 🌟 What makes BrowOS special?

- **Zero setup or backend**: Just open `index.html` in any modern web browser (`file://` or HTTP).
- **Real RISC-V Architecture**: Simulates an authentic **RV32IM** CPU with Machine (M), Supervisor (S), and User (U) privilege rings.
- **True Virtual Memory (Sv32 MMU)**: Two-level paging with TLB caching, 4 KiB pages, 4 MiB superpages, and memory protection between user processes and the kernel.
- **Preemptive Multitasking Kernel**: Real assembly supervisor with a timer-driven round-robin scheduler, PCB process tables, Unix-like system calls (`fork`, `exec`, `waitpid`, `pipe`, `kill`), and signals.
- **On-Disk Filesystem (BrFS)**: A custom block-based filesystem supporting directory hierarchies, file creation, reading, writing, and deletion.
- **Interactive ANSI Terminal**: High-performance canvas-based terminal emulator supporting VT100 escape sequences, full 16-color ANSI palettes, and scrollback history.
- **BrowGPU Hardware Acceleration**: A virtual graphics accelerator supporting command buffers and raytracing compute shaders (like the real-time 3D spinning globe).
- **100% Tested & Verified**: Backed by 198 automated unit and architectural compliance tests, including the official RISC-V test suites.

---

## 🚀 Quick Start

### 1. Run in the Browser
Simply open `index.html` in Chrome, Firefox, Safari, or Edge:
```bash
# Windows
start index.html

# macOS
open index.html

# Linux
xdg-open index.html
```

You'll be greeted by the BrowOS workstation interface. The system boots the kernel, mounts the root disk, and spawns the interactive shell.

### 2. Run Tests & Build from Source
If you want to modify or compile the OS yourself, you only need [Node.js](https://nodejs.org/):

```bash
# Run all 198 automated test suites (zero npm dependencies required!)
npm test

# Assemble the kernel, compile user programs, format the disk, and bundle index.html
npm run build

# Run full validation (tests + build bundle)
npm run check
```

---

## 💻 Exploring the Shell

Once the prompt appears (`browos:/$ `), you can interact with the system just like a classic Unix workstation:

| Command | Description | Example |
| :--- | :--- | :--- |
| `help` | Lists all available built-in commands and utilities | `help` |
| `ls` | Lists files and directories in the current working directory | `ls` |
| `cd <path>` | Changes the current directory (`..` to go up, `/` for root) | `cd /` |
| `pwd` | Prints the absolute path of the current working directory | `pwd` |
| `cat <file>` | Reads and displays the text contents of a file | `cat readme.txt` |
| `touch <file>` | Creates a new empty file | `touch notes.txt` |
| `mkdir <dir>` | Creates a new directory | `mkdir src` |
| `rmdir <dir>` | Removes an empty directory | `rmdir src` |
| `ps` | Displays the process table (PID, PPID, state, priority, name) | `ps` |
| `kill <pid>` | Sends a termination signal (`SIGKILL`) to a process | `kill 2` |
| `uname` | Prints operating system and architecture information | `uname` |
| `globe` | Toggles real-time 3D raytracing compute on the BrowGPU | `globe` |
| `clear` | Clears the terminal screen | `clear` |
| `echo <text>` | Prints text to standard output | `echo Hello BrowOS!` |

> **Tip:** You can also click any of the **Quick Action** buttons on the right sidebar to trigger commands instantly!

---

## 🛠️ How It Works (Under the Hood)

Here is how the pieces fit together from bottom to top:

```
┌─────────────────────────────────────────────────────────┐
│                    Web Browser UI                       │
│  (Cyber Glassmorphic Dashboard, Telemetry & Controls)   │
├───────────────────────────┬─────────────────────────────┤
│   ANSI Terminal Canvas    │     BrowGPU Framebuffer     │
│   (UART0 Rx/Tx Stream)    │    (320x240 RGB32 Display)  │
├───────────────────────────┴─────────────────────────────┤
│                    Guest Userland                       │
│      /sh (Shell)  •  /globe (Raytracer)  •  libbrow     │
├─────────────────────────────────────────────────────────┤
│                   BrowOS Kernel (S-Mode)                │
│   • Preemptive Scheduler        • Sv32 Virtual Memory   │
│   • Process & Signal Manager    • BrFS Filesystem       │
│   • System Call Dispatcher      • Device Drivers        │
├─────────────────────────────────────────────────────────┤
│                  Virtual Hardware Bus                   │
│   • RV32IM CPU Emulator (M/S/U Privilege + Sv32 MMU)    │
│   • CLINT Timer (mtime/mtimecmp) & Software Interrupts  │
│   • 16550A UART Serial Port                             │
│   • 256 MiB RAM Bus & 1024 KiB RAM Block Device         │
│   • BrowGPU Compute & Raster Accelerator                │
└─────────────────────────────────────────────────────────┘
```

### 1. The Virtual Machine (`tools/cpu.js`, `tools/mem.js`, `tools/devices.js`)
- Emulates a 32-bit RISC-V processor executing integer arithmetic, bit manipulation, and multiplication/division instructions (RV32IM).
- Implements two-level virtual page translation with TLB caching (Sv32 MMU), enforcing strict privilege boundaries between User mode and Supervisor mode.
- Memory access uses native `DataView` operations with range-filtered MMIO buses for maximum speed in JavaScript.

### 2. The Kernel (`kernel/*.s`)
- Written in pure RISC-V assembly and assembled directly by `tools/asm.js`.
- Handles hardware interrupts from the CLINT timer to preempt running tasks and switch process contexts smoothly.
- Provides standard POSIX-like system calls to user programs via the `ecall` instruction.

### 3. The Filesystem (`kernel/fs.s`, `tools/mkfs.js`)
- **BrFS** uses 4 KiB blocks and an inode allocation table to store directories and files on a virtual disk.
- When bundling, `tools/bundle.js` formats the root disk and installs the default binaries and configuration.

### 4. The Terminal & Graphics (`web/terminal.js`, `tools/devices.js`)
- The terminal handles text rendering, cursor blinking, scrollback buffering, and keyboard input via standard UART interrupts.
- BrowGPU executes compute shaders in parallel, calculating 3D sphere ray intersections, diffuse lighting, and surface rotation to render the spinning Earth.

---

## 📁 Repository Structure

```text
BrowOS/
├── index.html        # The compiled, self-contained single-file OS
├── kernel/           # Operating system kernel written in RV32 assembly
│   ├── 0-memmap.s    # System memory map, constants & PCB structure
│   ├── pmm.s         # Physical memory frame allocator
│   ├── vmm.s         # Sv32 page table allocator and mapper
│   ├── proc.s        # Process creation, fork, waitpid, and exit
│   ├── sched.s       # Preemptive round-robin scheduler & context switcher
│   ├── syscall.s     # Syscall dispatcher and implementations
│   ├── fs.s          # BrFS filesystem driver
│   ├── exec.s        # ELF binary loader for user programs
│   └── driver_*.s    # UART, block device, and GPU hardware drivers
├── user/             # Guest userspace applications
│   ├── libbrow.s     # Userland runtime & syscall wrappers
│   ├── sh.s          # Interactive command-line shell
│   └── globe.s       # 3D raytracer compute client
├── tools/            # Developer tools & compiler pipeline
│   ├── asm.js        # RISC-V RV32IM two-pass assembler & ELF generator
│   ├── cpu.js        # RV32IM CPU emulator & Sv32 MMU
│   ├── mem.js        # DataView-accelerated Bus & CLINT timer
│   ├── devices.js    # UART, Block Device, and BrowGPU peripherals
│   ├── mkfs.js       # BrFS root disk image formatter
│   └── bundle.js     # Single-file HTML bundler
├── web/              # Web UI & Terminal frontend
│   ├── terminal.js   # Canvas-based ANSI terminal with scrollback
│   ├── app.js        # Web controller, event loop, and telemetry
│   └── style.css     # Cyber glassmorphic design system
└── tests/            # Test runner with 198 automated unit & compliance tests
```

---

## 📜 License

This project is licensed under the **Apache License 2.0** — see the [LICENSE](LICENSE) file for details.

Copyright © 2026 Souvik Dhara. All rights reserved.
