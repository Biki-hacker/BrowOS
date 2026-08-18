# BrowOS — Technical Architecture & Implementation Plan

> **Project:** BrowOS
> **Format:** One self-contained `.html` artifact
> **Execution:** Browser-local, no backend required
> **Primary technologies:** JavaScript + WebAssembly + HTML/CSS + WebGPU/WebGL
> **Concept:** A deliberately serious Unix-like operating-system simulation whose CPU, kernel, scheduler, memory manager, filesystem, devices, shell, compiler, GPU and application runtime all execute inside the browser.

---

## 0. The Thesis

BrowOS should **not** be implemented as “a webpage pretending to be a terminal.”

The correct mental model is:

```text
                         BROWSER
┌──────────────────────────────────────────────────────────────┐
│                       BrowOS HTML                            │
│                                                              │
│   Browser Host Layer                                         │
│   ├── DOM / Terminal UI                                      │
│   ├── Keyboard / Pointer                                     │
│   ├── WebGPU / WebGL                                         │
│   ├── File Import / Export                                   │
│   ├── Workers / timers                                       │
│   └── Browser capability adapter                             │
│                                                              │
│   BrowOS Machine                                              │
│   ┌────────────────────────────────────────────────────────┐ │
│   │ Virtual Hardware                                        │ │
│   │                                                        │ │
│   │  RV32IM CPU(s)                                         │ │
│   │  MMU / TLB                                             │ │
│   │  Interrupt Controller                                  │ │
│   │  Timer                                                 │ │
│   │  UART / Console                                        │ │
│   │  Block Device                                          │ │
│   │  Virtual GPU                                           │ │
│   │  RAM                                                    │ │
│   │                                                        │ │
│   └────────────────────────────────────────────────────────┘ │
│                         ↓                                    │
│   ┌────────────────────────────────────────────────────────┐ │
│   │ BrowOS Kernel                                           │ │
│   │                                                        │ │
│   │ Boot                                                    │ │
│   │ Scheduler                                               │ │
│   │ Processes                                               │ │
│   │ Virtual Memory                                          │ │
│   │ Syscalls                                                │ │
│   │ VFS                                                     │ │
│   │ Drivers                                                 │ │
│   │ IPC                                                     │ │
│   │ Signals                                                 │ │
│   └────────────────────────────────────────────────────────┘ │
│                         ↓                                    │
│   ┌────────────────────────────────────────────────────────┐ │
│   │ Userland                                                │ │
│   │                                                        │ │
│   │ init → shell → programs                                │ │
│   │ assembler / compiler / utilities                       │ │
│   │ tiny AI runtime                                        │ │
│   │ GPU programs                                            │ │
│   └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

The browser is the **machine hosting BrowOS**, not BrowOS itself.

The objective is therefore not to fake system calls or fake processes in JavaScript. The objective is to make those concepts exist as actual data structures and execution paths inside the virtual machine.

That distinction is what makes the project technically interesting.

---

# 1. The Architecture We Should Build

The recommended stack is:

```text
HTML
 └── JS host/runtime
       ├── terminal/UI
       ├── browser device adapters
       ├── VM lifecycle
       ├── save/load
       └── capability detection

WebAssembly
 ├── RISC-V CPU core
 ├── hot memory paths
 ├── instruction decoder
 ├── MMU primitives
 ├── filesystem primitives
 ├── compression
 └── optional CPU-side inference

WebGPU
 ├── BrowOS GPU
 ├── raytracing compute workload
 ├── framebuffer generation
 └── ML acceleration

Web Workers
 ├── VM worker
 ├── rendering worker where useful
 └── optional inference worker

SharedArrayBuffer / Atomics
 └── fast shared-memory mode when browser deployment permits it
```

The implementation should be **hybrid**, not “all JavaScript” and not “compile the entire OS into WebAssembly.”

JavaScript is excellent at browser integration and orchestration.

WebAssembly is excellent for dense numerical work, CPU emulation, memory operations and deterministic low-level code.

WebGPU is the correct weapon for massively parallel ray tracing and tensor operations.

The RISC-V choice should be **RV32IM**.

Why RV32IM?

RV32I gives us a clean, real 32-bit ISA designed to be a compiler target and to support operating systems. The `M` extension provides integer multiply/divide and is valuable for realistic compiled programs while remaining drastically simpler than RV64GC.

Do not start with RV64GC.

The larger address width buys us almost nothing for this project while increasing implementation and debugging surface substantially.

---

# 2. What BrowOS Actually Is

The target machine should expose something similar to:

```text
CPU:
    ISA: RV32IM
    privilege: M + S + U
    virtual cores: 1 initially
    optional experimental multicore mode later

RAM:
    e.g. 256 MiB virtual physical RAM
    configurable at boot

Virtual storage:
    RAM-backed block device
    e.g. 256–1024 MiB logical disk
    only exists for current BrowOS session

GPU:
    virtual BrowGPU device
    framebuffer
    compute interface
    raytracing workload
    AI accelerator interface

Devices:
    UART
    timer
    interrupt controller
    block device
    random source
    GPU
    pseudo network device later
```

The machine should expose an actual memory map.

Example:

```text
0x00000000 ──────────────────────── RAM
            |
            | kernel memory
            | page tables
            | process memory
            | heap
            | stacks
            |
0x10000000 ──────────────────────── UART
0x10001000 ──────────────────────── TIMER
0x10002000 ──────────────────────── INTERRUPT CONTROLLER
0x10003000 ──────────────────────── BLOCK DEVICE
0x10004000 ──────────────────────── GPU CONTROL
0x10005000 ──────────────────────── GPU COMMAND BUFFER
0xFFFFF000 ──────────────────────── MMIO end
```

The exact address map should be finalized before implementing drivers.

---

# 3. The Most Important Constraint: Single HTML

This requires an explicit architectural distinction:

## Distribution mode

Everything resides inside:

```text
browos.html
```

including:

```text
HTML
CSS
JavaScript
Wasm binaries
initial filesystem image
embedded shaders
embedded fonts/assets
default programs
metadata
```

No network request should be required to boot.

A normal browser can therefore load the file and BrowOS can start offline.

---

# 4. But There Is One Major Browser Constraint

High-performance Wasm threading normally relies on:

```text
SharedArrayBuffer
       ↓
Web Workers
       ↓
Wasm shared memory / Atomics
```

SharedArrayBuffer availability is tied to cross-origin isolation. Modern browsers generally require COOP/COEP headers for unrestricted use.

A static HTML file cannot itself set an HTTP response header.

Therefore:

```text
file://browos.html
```

cannot be assumed to have the exact same threading environment as:

```text
https://example.com/browos.html
```

served with:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

This is not a BrowOS flaw.

It is a browser security boundary.

So BrowOS needs **two execution profiles**.

---

# 5. BrowOS Execution Profiles

## Profile A — Universal Single-File Mode

```text
browos.html
   ↓
Browser
   ↓
JS
   ↓
Wasm
   ↓
single VM execution worker
```

Characteristics:

```text
No SAB dependency
No cross-origin isolation dependency
Works as a local file as far as browser APIs permit
Fully self-contained
```

Use message passing between the UI and VM worker.

The entire guest machine itself can still execute inside a Web Worker, preventing CPU emulation from freezing the UI.

This is a critical design decision.

The Reddit OS-dev/WebAssembly community has repeatedly pointed out this practical pattern: a browser-hosted emulator does not necessarily need pthread-style shared memory; running the entire Wasm/VM in a Worker is a viable fallback.

---

## Profile B — Accelerated Hosted Mode

When:

```text
crossOriginIsolated === true
```

BrowOS enables:

```text
SharedArrayBuffer
Atomics
Wasm shared memory
multi-worker execution
higher precision timing
```

Modern browsers expose these facilities to cross-origin-isolated documents.

This gives BrowOS:

```text
UI Worker
     │
     │ shared command/state memory
     ▼
VM Worker
     │
     ├── CPU
     ├── Kernel
     ├── devices
     │
     └── optional GPU/inference worker
```

Eventually:

```text
Core 0
Core 1
Core 2
...
```

could become possible.

But that is **not the first implementation**.

---

# 6. Threading Philosophy

Do not make the virtual CPU multithreaded immediately.

That sounds impressive.

It is also an excellent way to create a debugging nightmare.

The virtual operating system should support **multiple guest processes**, while the virtual hardware begins as a **single virtual CPU**.

Therefore:

```text
Many guest processes
        ↓
one virtual CPU
        ↓
preemptive kernel scheduler
```

This gives us real:

* process state
* context switching
* scheduling
* blocking
* sleeping
* wakeups
* system calls
* signals

without having to reason about simultaneous modifications to the virtual physical machine.

Later:

```text
CPU 0
CPU 1
CPU 2
CPU 3
```

can be experimental.

Even OSDev practitioners recommend beginning with a simple ready queue and increasing scheduler complexity incrementally rather than trying to invent a complicated scheduler first.

---

# 7. RISC-V CPU

## Recommended ISA

```text
RV32IM
```

with:

```text
I = base integer ISA
M = multiplication/division
```

Then:

```text
Privileged architecture:
M-mode
S-mode
U-mode
```

The privileged RISC-V architecture explicitly defines machine and supervisor mechanisms necessary for operating systems and devices; U-mode is intended for applications and S-mode for conventional operating systems.

This gives BrowOS an actual privilege boundary.

---

# 8. CPU Internal Structure

Do not implement the CPU as a huge switch statement in JavaScript.

Use Wasm.

Conceptually:

```text
CPU
├── x[32]
├── pc
├── mstatus
├── mtvec
├── mepc
├── mcause
├── mtval
├── satp
├── scause
├── sepc
├── stvec
├── sstatus
├── sie
├── sip
└── counters/debug state
```

Every instruction follows:

```text
FETCH
   ↓
DECODE
   ↓
EXECUTE
   ↓
MEMORY ACCESS
   ↓
WRITEBACK
   ↓
PC UPDATE
```

For each instruction:

```text
instruction = physical/virtual memory read
opcode = instruction & mask
decoder selects operation
operation updates registers/memory/CSR
```

---

# 9. Interpreter vs JIT

Version 1:

```text
RV32IM interpreter
```

Version 2:

```text
block/JIT cache
```

This distinction matters enormously.

An interpreter might do:

```text
fetch
decode
dispatch
execute
```

for every guest instruction.

A block translator instead recognizes:

```text
0x1000:
  add
  addi
  lw
  add
  bne
```

and turns the whole basic block into a faster host representation.

The browser emulator v86 demonstrates that sophisticated browser emulation can go substantially further by translating guest machine code into WebAssembly for better performance. Its emulator supports an x86 PC, many devices and an x86-to-Wasm JIT.

For BrowOS, however, a full dynamic binary translator should be postponed.

### Recommended progression

```text
Phase 1:
Interpreter

Phase 2:
Decoded instruction cache

Phase 3:
Basic-block cache

Phase 4:
Wasm-native hot block/JIT experiment
```

Do not build the JIT before the OS is stable.

---

# 10. CPU Verification

This is where BrowOS becomes much more serious.

Use:

```text
RISC-V Architectural Certification Tests
```

as a correctness reference rather than testing everything manually.

The current RISC-V architectural test suite is specifically designed to test implementations against the ISA specification and can use reference models such as Sail to generate expected behavior.

Also use:

```text
Spike
```

as a differential reference during development.

Spike implements RV32I/RV64I and numerous extensions and is explicitly intended as a RISC-V ISA simulator.

Development loop:

```text
test program
     │
     ├── BrowCPU
     │
     └── Spike
          │
          └── compare:
                PC
                registers
                memory writes
                traps
```

The idea of lock-step comparison against Spike is already used in real RISC-V hardware verification workflows.

---

# 11. The MMU

This should be **real enough to hurt**.

Implement:

```text
virtual address
       ↓
page-table walk
       ↓
PTE
       ↓
physical address
```

Recommended virtual memory model:

```text
4 KiB pages
two-level page table initially
```

Even though real RISC-V systems offer more elaborate paging modes, the architecture should expose a clean interface allowing a future Sv32 implementation.

For RV32, Sv32 is particularly appropriate.

Conceptually:

```text
VA
┌────────┬────────┬────────────┐
│ VPN[1] │ VPN[0] │ page offset│
└────────┴────────┴────────────┘
```

Then:

```text
satp
 ↓
root page table
 ↓
VPN[1]
 ↓
second level
 ↓
VPN[0]
 ↓
PTE
 ↓
physical page
```

---

# 12. TLB

Do not walk page tables on every memory access.

Add:

```text
TLB
```

e.g.:

```text
32–128 entries
```

using a simple replacement policy initially.

Path:

```text
Virtual address
       ↓
TLB lookup
   ┌────┴────┐
  hit       miss
   │          │
   │     page walk
   │          │
   └────┬─────┘
        ↓
 physical address
```

The TLB is one of the highest-value “this is an actual VM” features in the whole project.

---

# 13. Simulated Physical RAM

Physical RAM should not be represented as millions of JavaScript objects.

Absolutely do not do:

```text
memory[0] = {...}
memory[1] = {...}
```

Use contiguous typed storage.

Preferred:

```text
ArrayBuffer
```

or, in accelerated mode:

```text
SharedArrayBuffer
```

backed by typed arrays / Wasm linear memory.

WebAssembly itself exposes linear memory in fixed 64 KiB pages, and the JS API can create memories with initial and maximum page counts.

However, BrowOS physical memory and Wasm memory should conceptually remain separate.

Important distinction:

```text
Host memory
       ↓
Wasm memory

Guest physical RAM
       ↓
BrowOS-managed region
```

Do not allow arbitrary guest addresses to become arbitrary host addresses.

---

# 14. Physical Memory Manager

Implement:

```text
frame allocator
```

initially using a bitmap:

```text
1 bit = 1 physical page
```

For 256 MiB:

```text
256 MiB / 4096
≈ 65,536 pages
```

Only:

```text
65,536 bits
≈ 8 KiB
```

are needed for the allocation bitmap.

Have APIs equivalent to:

```text
alloc_frame()
free_frame()
zero_frame()
refcount_frame()
```

Later:

```text
slab allocator
buddy allocator
```

can be added.

Start with bitmap + page allocator.

---

# 15. Kernel Memory

Separate:

```text
physical frame allocator
```

from:

```text
kernel virtual heap
```

The kernel should have:

```text
kmalloc
kfree
vmalloc-like region if eventually needed
```

For the first version:

```text
physical page allocator
        +
simple kernel heap
```

is enough.

---

# 16. Process Model

Create a real process control block.

Example conceptually:

```text
PCB
├── PID
├── PPID
├── state
├── priority
├── registers
├── pc
├── stack
├── address space
├── open file descriptors
├── cwd
├── environment
├── signal state
├── exit code
├── CPU accounting
└── scheduling data
```

States:

```text
NEW
READY
RUNNING
BLOCKED
SLEEPING
STOPPED
ZOMBIE
DEAD
```

This immediately enables useful shell commands:

```text
ps
top
kill
sleep
jobs
fg
bg
```

---

# 17. Context Switching

Guest context switching should be real.

The kernel saves:

```text
x1...x31
pc
status state
relevant CSRs
```

and restores the next process.

Conceptually:

```text
Process A
   ↓
timer interrupt
   ↓
kernel
   ↓
save A context
   ↓
scheduler
   ↓
select B
   ↓
restore B context
   ↓
return from trap
   ↓
Process B
```

This is the heart of BrowOS.

The browser itself may only be executing one VM thread, but **inside that VM the OS is doing real preemptive multitasking**.

---

# 18. Scheduler

Start with:

```text
preemptive priority round-robin
```

Example:

```text
priority 0: system
priority 1: interactive
priority 2: normal
priority 3: background
```

Each priority has a ready queue.

```text
runqueues[0]
runqueues[1]
runqueues[2]
runqueues[3]
```

Within a priority level:

```text
round robin
```

This provides:

* fairness
* predictable behavior
* easy debugging
* interactive shell responsiveness
* real scheduling behavior

Later consider:

```text
dynamic priority
aging
sleep bonus
CPU usage weighting
```

Do not attempt CFS initially.

---

# 19. Timer and Preemption

Create a virtual timer device.

Host/browser time should **not directly equal guest time**.

Instead:

```text
host time
   ↓
virtual timer driver
   ↓
timer interrupt
   ↓
kernel scheduler
```

The scheduler should have a configurable tick:

```text
1 ms
5 ms
10 ms
```

But beware:

browser timers are not hardware timers.

Therefore the kernel must treat the timer as a virtual device whose timing source is ultimately the browser runtime.

This is okay.

The correctness target is:

```text
correct ordering and semantics
```

not real-time hardware determinism.

---

# 20. Interrupts

Implement:

```text
timer interrupt
UART interrupt
GPU interrupt
block-device interrupt
```

Conceptually:

```text
device
  ↓
interrupt controller
  ↓
pending IRQ
  ↓
CPU trap logic
  ↓
kernel ISR
```

Do not simply invoke:

```text
kernel.onTimer()
```

from JavaScript.

Make the simulated hardware assert an interrupt line and have the CPU observe it according to its interrupt state.

That maintains architectural cleanliness.

---

# 21. Syscall Layer

Use a real guest syscall ABI.

Example:

```text
a7 = syscall number
a0-a5 = arguments
ecall
```

Then:

```text
U-mode
  ↓
ecall
  ↓
trap
  ↓
S-mode kernel
  ↓
syscall dispatcher
```

Initial syscall set:

```text
exit
fork
exec
wait
read
write
open
close
stat
mkdir
unlink
chdir
getcwd
sleep
yield
getpid
kill
mmap
munmap
brk
pipe
dup
dup2
```

Do not implement every POSIX syscall.

Implement a coherent BrowOS ABI.

---

# 22. BrowOS User ABI

Define:

```text
BrowOS ABI v1
```

including:

```text
register convention
syscall numbers
memory alignment
ELF/binary format
program entrypoint
stack layout
environment layout
file descriptor semantics
signal conventions
```

This lets us compile actual BrowOS programs.

---

# 23. Executable Format

Do not invent a random binary format if you want the system to feel legitimate.

Use a subset of:

```text
ELF32 RISC-V
```

That gives the internal compiler a real executable target.

The loader performs:

```text
ELF
 ↓
parse headers
 ↓
map segments
 ↓
allocate pages
 ↓
copy program data
 ↓
zero BSS
 ↓
create stack
 ↓
set PC
 ↓
enter U-mode
```

This is dramatically more impressive than:

```text
loadJSFunction(...)
```

---

# 24. Internal Assembler

This is absolutely feasible.

Implement:

```text
basm
```

perhaps:

```text
$ asm hello.s -o hello
```

Assembler pipeline:

```text
source
 ↓
lexer
 ↓
parser
 ↓
symbol table
 ↓
instruction encoder
 ↓
relocation
 ↓
ELF writer
```

Support initially:

```text
.text
.data
.bss

.globl
.section
.byte
.word
.asciz

labels
constants
```

Instructions:

```text
add
sub
addi
lw
sw
lb
sb
and
or
xor
sll
srl
sra
slt
beq
bne
blt
bge
jal
jalr
lui
auipc
ecall
ebreak
mul
div
rem
```

---

# 25. Internal Compiler

This is substantially larger.

Do not attempt a complete GCC.

Create:

```text
bcc
```

BrowOS C-like compiler.

Target language:

```text
C-ish subset
```

Support:

```text
int
char
pointers
arrays
struct
functions
if
else
while
for
return
break
continue
```

Compiler:

```text
source
 ↓
lexer
 ↓
parser
 ↓
AST
 ↓
type checker
 ↓
IR
 ↓
optimization
 ↓
RISC-V code generation
 ↓
ELF
```

Use SSA-like IR eventually.

---

# 26. Compiler Strategy

Do not implement a huge optimizing compiler first.

Stage it:

### Stage 1

Direct AST → RISC-V.

### Stage 2

Add IR.

### Stage 3

Constant folding.

### Stage 4

Dead-code elimination.

### Stage 5

Common-subexpression elimination.

### Stage 6

Register allocation.

### Stage 7

Better instruction selection.

The goal is not to outperform GCC.

The goal is:

```text
$ cc hello.c -o hello
$ ./hello
Hello from BrowOS
```

actually producing a RISC-V executable.

That alone is a ridiculous showcase.

---

# 27. Runtime / libc

Create a tiny:

```text
libbrow
```

instead of trying to port glibc.

Functions:

```text
printf
puts
strlen
memcpy
memset
strcmp
malloc
free
exit
read
write
open
close
```

The shell and utilities can link against this.

---

# 28. Virtual Filesystem

The filesystem should be layered.

```text
VFS
 │
 ├── tmpfs-like RAM FS
 │
 └── virtual block filesystem
```

For BrowOS's first filesystem:

```text
brfs
```

Design it specifically for an in-memory VM disk.

---

# 29. Filesystem Design

Recommended layout:

```text
superblock
inode table
directory records
data blocks
free-block bitmap
```

Use:

```text
4 KiB blocks
```

Directories map:

```text
name → inode
```

Inode:

```text
mode
uid
gid
size
timestamps
link count
direct blocks
indirect blocks
```

This makes:

```text
ls
cat
cp
mv
rm
mkdir
rmdir
touch
chmod
stat
```

real filesystem operations.

---

# 30. RAM-backed Storage

At runtime:

```text
virtual disk
       ↓
Uint8Array / Wasm memory
       ↓
filesystem blocks
```

The user's files vanish when the BrowOS session disappears.

Exactly as requested.

But BrowOS should additionally offer:

```text
save
load
```

for snapshots.

---

# 31. Save/Load Image System

This is one of the best features.

Command:

```text
$ save browos.bimg
```

or through the UI:

```text
SAVE IMAGE
```

Export:

```text
machine state
+
RAM
+
CPU registers
+
processes
+
filesystem
+
device state
+
configuration
```

into:

```text
.bimg
```

Then:

```text
$ load browos.bimg
```

restores it.

A `.bimg` file becomes an actual portable snapshot of the virtual computer.

---

# 32. Snapshot Format

Design:

```text
BIMG
├── magic
├── version
├── architecture
├── CPU state
├── memory map
├── RAM image
├── filesystem image
├── process table
├── device state
├── GPU state
└── checksum
```

Compression:

```text
filesystem + RAM snapshot
        ↓
compression
```

Modern browsers expose `CompressionStream`, including gzip, deflate and, in current implementations, zstd support.

Use whichever browser support matrix we finalize during implementation.

Do not assume zstd availability universally without runtime detection.

---

# 33. Snapshot Integrity

Every image should contain:

```text
magic
version
checksum
architecture
```

Example:

```text
BROWOSIMG
version = 1
arch = RV32IM
```

Validate:

```text
magic
size
version
checksum
```

before replacing the live VM.

Never load corrupted state directly into the running machine.

Load into a temporary buffer, validate, then commit.

---

# 34. Terminal

The shell should be visually minimal.

The actual terminal backend should be:

```text
TTY
 ↓
line discipline
 ↓
shell
```

not:

```text
input box → JS command parser
```

The shell itself should be a BrowOS process.

---

# 35. Shell

Implement:

```text
brsh
```

Unix-ish syntax.

Commands:

```text
help
clear
echo
pwd
cd
ls
cat
head
tail
mkdir
rmdir
touch
rm
cp
mv
find
grep
wc
sort
ps
top
kill
sleep
whoami
uname
free
mem
uptime
mount
df
dmesg
date
env
export
which
run
asm
cc
save
load
reboot
shutdown
```

---

# 36. Shell Parsing

Need:

```text
quotes
escaping
redirection
pipes
background jobs
```

Examples:

```text
echo hello > a.txt

cat a.txt | grep hello

ls /bin | sort

sleep 10 &

cat < input.txt > output.txt
```

Parser architecture:

```text
input
 ↓
lexer
 ↓
tokens
 ↓
shell grammar
 ↓
AST / command graph
 ↓
process creation
 ↓
pipe setup
 ↓
exec
```

---

# 37. Pipes

Pipe implementation:

```text
ring buffer
```

Kernel object:

```text
pipe
├── read end
├── write end
├── buffer
├── readers
└── writers
```

Then:

```text
producer
    ↓
 pipe
    ↓
consumer
```

This becomes a genuine kernel IPC primitive.

---

# 38. Signals

Implement a small subset:

```text
SIGTERM
SIGKILL
SIGINT
SIGSTOP
SIGCONT
SIGCHLD
```

Then:

```text
Ctrl+C
   ↓
TTY
   ↓
SIGINT
   ↓
foreground process
```

Now the shell behaves like an actual shell.

---

# 39. Device Model

Every virtual hardware component should share a common device API.

Conceptually:

```text
Device
├── init()
├── read()
├── write()
├── ioctl()
├── tick()
└── irq()
```

Devices:

```text
uart
timer
intc
block
gpu
rng
```

The kernel should talk to devices through drivers rather than knowing browser APIs.

---

# 40. UART

UART is the first display device.

Guest:

```text
write(fd=1, "hello")
```

Kernel:

```text
stdout → tty → UART
```

Host:

```text
UART buffer → terminal renderer
```

This separation matters.

---

# 41. Browser Terminal Rendering

The terminal UI is **not the operating system terminal**.

It is the host's terminal frontend.

Use a custom high-performance renderer rather than overengineering with a huge framework.

Potential representation:

```text
cell:
    character
    foreground
    background
    attributes
```

Maintain:

```text
screen buffer
cursor
scrollback
```

Only changed cells need repainting.

---

# 42. GPU — BrowGPU

This is where the project becomes visually insane.

The GPU should be conceptually presented to the guest OS as:

```text
BrowGPU
```

with:

```text
command buffer
framebuffer
compute queues
GPU memory
```

The physical implementation underneath can use:

```text
WebGPU
```

WebGPU exposes compute pipelines with storage-buffer/storage-texture outputs and is designed for compute workloads in browser environments.

This is ideal for:

```text
ray tracing
linear algebra
LLM kernels
image processing
```

---

# 43. Do Not Make the GPU Fake

Avoid:

```text
$ globe
→ JS directly renders globe
```

Instead:

```text
guest program
    ↓
GPU syscall / device API
    ↓
BrowGPU driver
    ↓
GPU command buffer
    ↓
WebGPU backend
    ↓
shader
    ↓
framebuffer
    ↓
browser canvas
```

Now the guest OS genuinely controls a virtual accelerator.

---

# 44. GPU Memory Model

Give BrowGPU virtual memory:

```text
GPU VRAM
```

which is actually backed by host-side resources:

```text
GPUBuffer
GPUTexture
```

but represented to the guest through device handles.

Example:

```text
gpu_alloc
gpu_free
gpu_upload
gpu_dispatch
gpu_present
```

The guest should never receive a raw JavaScript `GPUBuffer`.

---

# 45. The Raytracing Showcase

The first spectacular GPU application should be:

```text
globe
```

Scene:

```text
sphere / Earth
        +
terrain texture
        +
ocean
        +
atmosphere
        +
light source(s)
```

Do not require a physically accurate path tracer.

Implement a compute-based ray tracer:

```text
ray per pixel
        ↓
sphere intersection
        ↓
surface normal
        ↓
light evaluation
        ↓
shadow ray
        ↓
atmosphere
        ↓
pixel
```

Later:

```text
BVH
```

for accelerated scene traversal.

---

# 46. Why Compute Instead of Graphics Pipeline?

The GPU showcase should specifically demonstrate that BrowGPU is an accelerator.

Therefore:

```text
GPU command
→ compute shader
→ write framebuffer
```

rather than merely:

```text
draw sphere with ordinary rasterization
```

This is technically more interesting.

---

# 47. WebGL Fallback

WebGL 2 should remain the graphical fallback.

WebGL2 framebuffers and texture attachment are mature and broadly available, including framebuffer operations in worker-capable contexts.

Architecture:

```text
BrowGPU
   │
   ├── WebGPU backend
   │      ↓
   │   compute / rendering
   │
   └── WebGL2 backend
          ↓
       rendering fallback
```

But the raytracing kernel should preferentially use WebGPU.

---

# 48. GPU API Seen By User Programs

Something like:

```text
open("/dev/gpu0")

gpu_alloc(...)
gpu_upload(...)
gpu_dispatch(...)
gpu_present(...)
```

or a higher-level libc wrapper:

```text
brow_gpu_create_context()
brow_gpu_buffer_create()
brow_gpu_dispatch()
brow_gpu_present()
```

This makes the GPU part of the OS instead of merely a UI trick.

---

# 49. Tiny LLM

The phrase “tiny LLM” needs discipline.

Do not attempt to ship:

```text
7B+
```

inside the default BrowOS image.

That would make the single HTML enormous and startup painful.

A better target is:

```text
~15M–100M parameter model
```

or another genuinely tiny quantized model.

Karpathy's `llama2.c` demonstrates that a small Llama-family inference engine can be expressed in remarkably little code, and its tiny 15M model is specifically intended for minimal experimentation.

---

# 50. AI Architecture

Expose:

```text
/dev/ai0
```

to BrowOS.

Application:

```text
$ ai "explain virtual memory"
```

Kernel:

```text
syscall
 ↓
AI driver
 ↓
BrowAI runtime
```

Then:

```text
BrowAI
├── WebGPU backend
└── Wasm CPU fallback
```

Modern community projects demonstrate that local browser inference using WebGPU + Wasm is very feasible, including tiny and quantized models.

---

# 51. AI Must Not Block the OS

The LLM should run outside the critical CPU emulation path.

Conceptually:

```text
BrowOS VM
     │
     └── AI request
             ↓
         AI Worker
             ↓
          WebGPU
             ↓
          results
```

Then:

```text
sleep / wait queue
```

allows the requesting guest process to block.

That is an actual OS workload:

```text
Process A:
wait for AI

Process B:
continue executing

Scheduler:
switches to B
```

---

# 52. Why WebGPU for the LLM

WebGPU can execute compute shaders using storage buffers, which maps naturally to matrix operations and inference kernels.

Community implementations of browser-local LLM inference report significant GPU acceleration over CPU/Wasm-only execution, although performance varies wildly with browser, GPU, model and quantization.

Therefore BrowOS should expose:

```text
WebGPU available
    ↓
GPU inference

otherwise
    ↓
Wasm inference
```

---

# 53. Don't Put the Full LLM Into the Kernel

The kernel should only manage:

```text
device
memory
process
IPC
```

The AI runtime should be a user-space service/application.

This is much cleaner.

Future:

```text
ai-server
```

runs as a user process.

Then:

```text
ai-cli
```

talks to it through IPC.

That is much more OS-like.

---

# 54. IPC Architecture

Implement:

```text
pipe
shared-memory region
message queue
```

in that order.

Eventually:

```text
$ ai ...
```

could talk to:

```text
ai-server
```

through a Unix-style socket/message abstraction.

This lets BrowOS demonstrate:

```text
user process
 ↕
IPC
 ↕
AI service
 ↕
GPU
```

---

# 55. Boot Process

BrowOS should have a genuine boot sequence.

Recommended sequence:

```text
HTML loaded
   ↓
Host runtime initialization
   ↓
Wasm runtime initialized
   ↓
Virtual machine allocated
   ↓
CPU reset
   ↓
Machine firmware
   ↓
Bootloader
   ↓
Kernel image loaded
   ↓
M-mode initialization
   ↓
S-mode initialization
   ↓
RAM manager
   ↓
MMU
   ↓
interrupt controller
   ↓
timer
   ↓
UART
   ↓
block device
   ↓
GPU
   ↓
filesystem mount
   ↓
process manager
   ↓
scheduler
   ↓
init
   ↓
shell
```

The UI should actually display this during development.

Example:

```text
[BROWOS BIOS]
CPU ............ RV32IM
RAM ............ 256 MiB
MMU ............ OK
INTC ........... OK
TIMER .......... OK
UART ........... OK
BLOCK .......... OK
GPU ............ WebGPU
FILESYSTEM ..... mounted
PROCESS ......... PID 1
INIT ........... OK

BrowOS 0.1
login:
```

This is excellent demo material.

---

# 56. Bootloader

Do not directly jump from JavaScript into the kernel.

Have:

```text
firmware
```

load:

```text
kernel ELF
```

and transfer control.

Later support a tiny boot menu:

```text
BrowBoot
---------
1. Boot BrowOS
2. Memory test
3. CPU test
4. Recovery shell
5. Hardware diagnostics
```

---

# 57. PID 1

Use:

```text
init
```

as the first user-space process.

It launches:

```text
shell
```

and later:

```text
device services
AI daemon
GPU services
```

This creates:

```text
kernel → init → services → shell
```

instead of directly spawning the shell from JavaScript.

---

# 58. Kernel Logging

Implement:

```text
dmesg
```

from the beginning.

Kernel log ring buffer:

```text
timestamp
severity
subsystem
message
```

Examples:

```text
[0.001] kernel: initializing MMU
[0.002] mem: detected 262144 KiB RAM
[0.003] sched: scheduler online
[0.004] vfs: mounting brfs
[0.005] gpu: WebGPU backend online
```

This becomes essential for debugging.

---

# 59. Debugger

Your developer-mode panel is worth building early.

Expose:

```text
CPU
├── registers
├── PC
├── current instruction
├── mode
├── CSRs
└── interrupt state

MMU
├── SATP
├── TLB
├── page tables
└── translations

Kernel
├── processes
├── run queues
├── file descriptors
└── syscalls

Memory
├── physical pages
├── allocations
└── virtual maps

Filesystem
├── superblock
├── inode table
└── open handles
```

---

# 60. Instruction Tracing

Every instruction can optionally emit:

```text
PC
instruction
decoded mnemonic
register writes
memory accesses
trap
```

Example:

```text
PC=0x80001234
0x00500513  li a0,5
x10 ← 0x00000005
```

But this must be **disabled by default**.

Debug tracing will destroy performance.

---

# 61. Breakpoints

Add:

```text
breakpoint(address)
```

Debugger commands:

```text
break 0x80001234
continue
step
next
regs
mem
stack
bt
```

This is an extremely strong showcase feature.

---

# 62. Deterministic Mode

Add:

```text
BrowOS deterministic mode
```

The VM scheduler can use a synthetic virtual clock.

This gives:

```text
same initial image
+
same random seed
+
same input stream
=
same execution
```

where feasible.

Determinism will massively improve testing.

---

# 63. Testing Architecture

BrowOS needs automated tests in layers.

## CPU tests

```text
instruction tests
CSR tests
trap tests
MMU tests
```

## Kernel tests

```text
scheduler
process creation
context switching
syscalls
IPC
signals
```

## Filesystem tests

```text
create
write
read
rename
delete
directory traversal
corruption recovery
```

## Compiler tests

```text
source → AST
source → assembly
source → ELF
program execution
```

## GPU tests

```text
buffer
shader
dispatch
framebuffer
```

## Snapshot tests

```text
save
load
compare state
```

---

# 64. Golden Tests

For every important subsystem:

```text
input
expected state
```

Example CPU:

```text
initial registers
+
instruction sequence
=
expected registers
```

Filesystem:

```text
create /foo
write hello
save
reload
read /foo
→ hello
```

---

# 65. Differential Testing

For CPU:

```text
BrowOS CPU
      ↕
Spike
```

For compiler:

```text
BrowCC output
      ↓
BrowOS
```

and optionally compare against:

```text
reference RISC-V toolchain
```

For architectural compatibility, use the official architectural tests.

---

# 66. Performance Instrumentation

Never optimize blindly.

Add:

```text
perf
```

to BrowOS.

Output:

```text
CPU:
  guest instructions/s
  host ms/tick
  interpreter %
  memory %
  syscall rate

Scheduler:
  context switches/s
  average run quantum
  runnable processes

MMU:
  TLB hits
  TLB misses
  page walks

Filesystem:
  blocks/s
  reads/s
  writes/s

GPU:
  dispatches/s
  frame time
  GPU time if measurable

AI:
  tokens/s
  prompt latency
```

This turns BrowOS into a performance experiment rather than merely a demo.

---

# 67. CPU Performance Strategy

The CPU is likely to be the primary bottleneck.

Optimization order:

```text
1. Wasm implementation
2. Typed contiguous memory
3. compact CPU state
4. instruction decoder optimization
5. decoded instruction cache
6. reduce host/guest crossings
7. batching
8. basic block execution
9. JIT if necessary
```

Critical rule:

**Do not call JavaScript for every guest instruction.**

That would be catastrophic.

The CPU should execute thousands/millions of guest instructions entirely inside Wasm before returning to JavaScript.

---

# 68. Host Calls

Use coarse-grained calls.

Bad:

```text
Wasm
 → JS write char
 → Wasm
 → JS write char
 → Wasm
```

Good:

```text
Wasm
 → write 4096 bytes
 → return
```

Likewise:

```text
CPU
 → syscall
 → kernel handles internally
 → only browser boundary when absolutely necessary
```

---

# 69. Worker Architecture

Recommended production topology:

```text
                        Browser
                           │
                    ┌──────▼──────┐
                    │ Main Thread │
                    │ UI / Input  │
                    └──────┬──────┘
                           │
                    message/SAB
                           │
                    ┌──────▼──────┐
                    │ VM Worker   │
                    │             │
                    │ Wasm CPU    │
                    │ Kernel      │
                    │ Devices     │
                    └──────┬──────┘
                           │
            ┌──────────────┴──────────────┐
            │                             │
      ┌─────▼─────┐                 ┌─────▼─────┐
      │ GPU Worker│                 │ AI Worker │
      │ optional  │                 │ optional  │
      └───────────┘                 └───────────┘
```

But in universal mode:

```text
Main
 ↓
VM Worker
    ├── CPU
    ├── Kernel
    ├── GPU
    └── AI
```

is perfectly acceptable.

---

# 70. Why a Worker Even Without Threads?

Because VM execution must not block rendering.

If the virtual CPU accidentally executes for:

```text
50 ms
100 ms
500 ms
```

on the browser's main thread, the terminal will visibly freeze.

Therefore:

```text
VM = Worker
UI = Main
```

should be foundational.

---

# 71. SharedArrayBuffer Strategy

Accelerated mode:

```text
SAB
├── control page
├── event queue
├── terminal ring buffer
├── debug state
└── shared device buffers
```

Use Atomics only for synchronization.

Do not turn every field into an atomic variable.

Use:

```text
bulk data = normal shared memory
control flags = Atomics
```

This avoids unnecessary synchronization overhead.

WebAssembly threads use shared WebAssembly memory backed by SharedArrayBuffer, enabling shared-memory synchronization between Workers.

---

# 72. Browser Compatibility Layer

At boot:

```text
detect:
  WebAssembly
  WebGPU
  WebGL2
  Worker
  SharedArrayBuffer
  crossOriginIsolated
  File APIs
```

Then choose:

```text
GPU:
WebGPU > WebGL2 > terminal-only

parallelism:
SAB+Workers > Worker message passing

AI:
WebGPU > Wasm CPU > disabled
```

BrowOS should never fail simply because WebGPU is missing.

---

# 73. Single HTML Embedding

The final artifact can contain:

```html
<script>
  // JavaScript
</script>

<script type="application/wasm">
...
</script>
```

However, browser execution of Wasm still needs proper byte handling.

A practical packaging approach is:

```text
HTML
 ├── base64 Wasm blob
 ├── shader strings
 ├── filesystem image
 └── JavaScript bootstrap
```

At startup:

```text
base64
 ↓
Uint8Array
 ↓
WebAssembly.instantiate
```

The WebAssembly JS API directly supports constructing a module from binary data and creating linear memory.

This makes a true one-file distribution feasible.

---

# 74. Embedded Wasm Compression

The single HTML could become huge.

Therefore use:

```text
build pipeline:
source
 ↓
compile
 ↓
optimize
 ↓
compress/bundle
 ↓
base64/embed
 ↓
browos.html
```

Do not hand-maintain the final HTML.

The development project can still have:

```text
src/
build/
tools/
```

and produce:

```text
dist/browos.html
```

as the final artifact.

The constraint applies to the **released artifact**, not necessarily the source repository.

---

# 75. Build Pipeline

Recommended source tree:

```text
browos/
├── kernel/
├── cpu/
├── mmu/
├── fs/
├── drivers/
├── scheduler/
├── shell/
├── compiler/
├── assembler/
├── libc/
├── gpu/
├── ai/
├── firmware/
├── userspace/
├── tests/
├── web/
├── tools/
└── dist/
```

Final build:

```text
all source
  ↓
Rust/C/C++ → Wasm
JS bundling/minification
shader embedding
filesystem image
  ↓
single HTML
```

---

# 76. Language Choice

Recommended:

## C/C++ or Rust for low-level Wasm

Use one primary systems language.

My recommendation:

```text
Rust
```

for:

```text
CPU
MMU
filesystem
compiler
assembler
kernel
```

Why?

Because BrowOS will contain many memory-heavy structures where Rust's safety is useful during development.

However:

```text
JavaScript
```

remains responsible for:

```text
browser API
UI
Worker orchestration
WebGPU integration
file import/export
```

---

# 77. Do Not Force Rust Everywhere

The GPU shaders should be:

```text
WGSL
```

The browser shell/UI remains:

```text
JavaScript
HTML
CSS
```

The guest userland is:

```text
RISC-V machine code
```

generated by:

```text
BrowCC / BrowASM
```

This creates a beautiful stack:

```text
WGSL
Rust/Wasm
JavaScript
RISC-V
BrowOS ABI
```

---

# 78. GPU API Boundary

Avoid making Rust/Wasm directly depend on every browser GPU object unless absolutely necessary.

Prefer:

```text
Wasm:
    command description

JS:
    interprets command
    submits WebGPU work
```

Later, performance-critical GPU operations can move toward direct Wasm/WebGPU bindings if worthwhile.

This keeps the initial architecture sane.

---

# 79. The Three Memory Worlds

BrowOS will have three different concepts of memory:

```text
1. Host memory
2. Guest physical RAM
3. GPU memory
```

and possibly:

```text
4. Guest virtual memory
```

Document these relentlessly.

Bad architecture:

```text
everything = one Uint8Array
```

Good architecture:

```text
Host
 ├── VM state
 ├── guest RAM
 └── GPU resources

Guest
 ├── physical RAM
 ├── virtual memory
 └── virtual GPU memory
```

---

# 80. Guest Memory Access API

CPU should use abstractions like:

```text
load8(va)
load16(va)
load32(va)
store8(va)
store16(va)
store32(va)
fetch32(va)
```

Internally:

```text
virtual address
 → TLB
 → MMU
 → physical address
 → RAM
```

This makes privilege violations and page faults real.

---

# 81. Page Faults

Implement:

```text
instruction page fault
load page fault
store page fault
access fault
misaligned access
illegal instruction
environment call
breakpoint
```

Then:

```text
invalid memory
 ↓
trap
 ↓
kernel
 ↓
SIGSEGV-like behavior
 ↓
process termination
```

This is a major milestone.

---

# 82. Security Boundary

BrowOS's user processes should not be able to:

```text
read kernel memory
modify other processes
write arbitrary physical memory
access MMIO directly
```

unless explicitly authorized.

That requires:

```text
U-mode
page tables
PTE permissions
trap handling
```

This is precisely why implementing genuine privileged architecture is worthwhile.

---

# 83. Kernel / User Separation

Memory layout:

```text
Virtual Address

0x00000000
    user text
    user data
    heap
    stack
    shared regions

      ...

high addresses

    kernel mapping
```

Whether kernel pages are globally mapped or dynamically switched is a later detail.

The important thing is:

```text
user cannot access kernel pages
```

---

# 84. Process Creation

Simplest real model:

```text
fork
```

will duplicate an address-space description.

Eventually implement:

```text
copy-on-write
```

instead of eagerly copying RAM.

That is another excellent advanced feature.

Process:

```text
fork()
```

creates:

```text
same physical pages
        ↓
read-only mappings
        ↓
write fault
        ↓
copy page
```

This makes BrowOS substantially more serious.

---

# 85. Virtual Memory Features — Staged

### V1

```text
paging
page allocation
permissions
TLB
page fault
```

### V2

```text
mmap
shared pages
copy-on-write
```

### V3

```text
demand-zero pages
file-backed mappings
```

Do not implement swap.

There is no reason to emulate disk-backed swapping when your physical VM exists entirely inside a browser memory budget.

---

# 86. Storage vs RAM

Keep these distinct:

```text
RAM:
    CPU-accessible memory

Storage:
    persistent within session
    accessed through block device
```

Even though both are physically represented in host memory.

This distinction is architectural, not physical.

---

# 87. Filesystem Page Cache

Later:

```text
filesystem block
 ↓
page cache
 ↓
memory page
```

This demonstrates real OS caching.

But V1 filesystem can directly map block buffers into kernel memory.

---

# 88. Block Device

Create:

```text
/dev/vblk0
```

with:

```text
read_block
write_block
flush
```

The filesystem talks to the block device.

The block device happens to be backed by an in-memory array.

That is perfectly valid virtualization.

---

# 89. Device Files

Expose:

```text
/dev/console
/dev/null
/dev/random
/dev/vblk0
/dev/gpu0
/dev/ai0
```

Possibly:

```text
/dev/fb0
```

for framebuffer experimentation.

---

# 90. `/proc`

A tiny virtual proc filesystem will make the OS feel far more authentic.

Examples:

```text
/proc/cpuinfo
/proc/meminfo
/proc/uptime
/proc/interrupts
/proc/processes
/proc/gpuinfo
```

Then:

```text
cat /proc/cpuinfo
```

prints:

```text
processor : 0
isa       : rv32im
priv      : m,s,u
```

---

# 91. `/sys`

Eventually:

```text
/sys/devices
/sys/kernel
/sys/gpu
```

The purpose is educational and architectural visibility.

---

# 92. `/bin`, `/usr`, `/etc`

Use a Unix-like layout:

```text
/
├── bin
├── sbin
├── usr
│   ├── bin
│   └── lib
├── etc
├── dev
├── proc
├── sys
├── tmp
├── home
└── var
```

Even if the underlying implementation is tiny.

---

# 93. First User Programs

Build:

```text
init
sh
ls
cat
echo
mkdir
rm
cp
mv
grep
ps
sleep
kill
mount
uname
mem
top
dmesg
```

Then:

```text
asm
cc
ai
gpu-demo
```

---

# 94. `uname`

Make it fun:

```text
$ uname -a

BrowOS 0.1.0 RV32IM brow-machine \
#1 SMP PREEMPT BROWGPU
```

---

# 95. `/bin/gpu-demo`

Running:

```text
gpu-demo
```

should launch the globe.

The terminal can become:

```text
[BrowGPU]
Ray tracing Earth...
Samples: 8
Lights: 2
Resolution: 1280x720
Backend: WebGPU
```

Then return to the shell.

---

# 96. GPU Demonstration Modes

Add:

```text
gpu-demo globe
gpu-demo spheres
gpu-demo reflections
gpu-demo shadows
gpu-demo benchmark
```

Benchmark:

```text
ray/s
ms/frame
GPU buffer throughput
```

This converts the flashy GPU code into an actual benchmarkable subsystem.

---

# 97. AI Demonstration

Command:

```text
ai "what is a page table?"
```

Architecture:

```text
shell
 ↓
ai client
 ↓
IPC
 ↓
AI service
 ↓
BrowAI
 ↓
WebGPU
```

This is much cooler than simply embedding an LLM call directly in JavaScript.

---

# 98. AI Model Packaging

Don't bake multiple giant models into the base image.

Instead support:

```text
ai install model.bmodel
```

where:

```text
.bmodel
```

is a BrowOS model package.

For the showcase HTML, include one tiny model.

Users could later:

```text
load /models/custom.bmodel
```

through image import or explicit model import.

---

# 99. Browser Save Model

BrowOS has two kinds of files:

```text
guest files
```

and:

```text
host snapshot files
```

Guest:

```text
/home/user/file.txt
```

Snapshot:

```text
Downloads/browos-project.bimg
```

The host browser is merely the transport layer.

---

# 100. File Import/Export UX

UI buttons:

```text
SAVE IMAGE
LOAD IMAGE
RESET
```

Command equivalents:

```text
save
load
```

The exact browser file APIs should be capability-detected rather than assumed.

The fallback can use:

```text
<input type=file>
Blob download
```

This keeps the core architecture browser-version tolerant.

---

# 101. Crash Recovery

BrowOS should distinguish:

```text
guest process crash
kernel panic
browser/runtime crash
```

Kernel panic screen:

```text
===============================
        KERNEL PANIC
===============================

cause: invalid page-table entry
pid:   7
pc:    0x80001324
mode:  S

register dump...
stack trace...
```

Then:

```text
[REBOOT]
[DEBUGGER]
[SAVE CRASH DUMP]
```

This will make debugging vastly easier.

---

# 102. Crash Dumps

Support:

```text
save crashdump.bcd
```

containing:

```text
CPU
RAM regions
page tables
process state
kernel log
filesystem metadata
```

Excellent for development and demos.

---

# 103. Browser Lifecycle

When tab closes:

```text
BrowOS disappears
```

That is intentional.

But don't depend on:

```text
beforeunload
```

for correctness.

The machine simply exists in memory.

If saved:

```text
.bimg
```

becomes the persistent state.

---

# 104. No IndexedDB by Default

Do not secretly introduce persistent browser storage.

That violates the conceptual model.

Potential future optional feature:

```text
--persistent
```

but that should be explicitly separate from the default architecture.

Default:

```text
RAM only
```

---

# 105. Performance Budget

A reasonable first target:

```text
Guest RAM:
256 MiB

Virtual disk:
256 MiB

CPU:
RV32IM

Processes:
100+ theoretical
10–50 practical interactive

Terminal:
60 FPS target

GPU:
WebGPU preferred

AI:
tiny quantized model
```

The exact memory limits should be adaptive.

---

# 106. Dynamic Memory Configuration

Boot option:

```text
browos.html?ram=512
```

could be supported in hosted mode.

But the default should remain conservative.

Example:

```text
RAM:
256 MiB

Disk:
256 MiB
```

because browser memory usage includes:

```text
Wasm
JS
DOM
GPU
model
buffers
```

not only guest RAM.

---

# 107. Memory Pressure

Implement host capability detection.

If:

```text
insufficient host memory
```

BrowOS should reduce:

```text
guest RAM
GPU resolution
model availability
```

instead of crashing immediately.

---

# 108. Browser Capability Matrix

At boot report:

```text
Browser capabilities
--------------------
WebAssembly     OK
Workers         OK
WebGL2          OK
WebGPU          OK
Shared memory   AVAILABLE / LIMITED
Cross origin    ISOLATED / NOT ISOLATED
AI accelerator  AVAILABLE / CPU
```

This also makes the demo self-explanatory.

---

# 109. Performance Modes

Add:

```text
performance
balanced
debug
```

### Performance

```text
JIT
reduced logging
GPU acceleration
batched execution
```

### Balanced

```text
interpreter
normal logging
```

### Debug

```text
tracing
assertions
statistics
breakpoints
```

---

# 110. Scheduler Performance

Do not let the shell itself overwhelm the CPU.

Interactive commands should not starve other workloads.

For example:

```text
$ stress &
$ gpu-demo &
$ top
```

must remain responsive.

That is the perfect demonstration of scheduler correctness.

---

# 111. `stress`

Build:

```text
stress
```

which intentionally burns CPU.

Then run:

```text
stress &
top
```

and observe:

```text
PID   STATE     CPU
1     sleeping  0%
2     running   93%
3     ready     5%
4     ready     2%
```

This makes the scheduler visible.

---

# 112. Memory Demo

Create:

```text
memdemo
```

that:

```text
allocates memory
writes pages
forks
writes again
```

and displays:

```text
physical frames
virtual pages
TLB entries
page faults
COW faults
```

That is an ideal virtual memory showcase.

---

# 113. Filesystem Demo

Create:

```text
fsdemo
```

showing:

```text
create
write
rename
delete
inode allocation
block allocation
```

Then:

```text
save image
reload image
```

and verify data survived the snapshot.

---

# 114. CPU Demo

Create:

```text
cpudemo
```

showing:

```text
instruction rate
register changes
trap events
branch rate
TLB hit/miss
```

---

# 115. Boot Diagnostics

Create:

```text
diag
```

which runs:

```text
CPU test
RAM test
MMU test
filesystem test
GPU test
AI test
snapshot test
```

Final output:

```text
[PASS] CPU RV32IM
[PASS] MMU
[PASS] Scheduler
[PASS] VFS
[PASS] GPU
[PASS] AI
[PASS] Snapshot
```

---

# 116. Development Phases

Do not build everything simultaneously.

The correct build order is:

## Phase 0 — Host Runtime

Implement:

```text
HTML
JS
Worker
Wasm loading
terminal
capability detection
```

Success:

```text
single HTML opens
terminal appears
```

---

## Phase 1 — RISC-V CPU

Implement:

```text
RV32I
M
register file
PC
memory bus
CSR basics
```

Success:

```text
execute hand-written RV32 program
```

---

## Phase 2 — CPU Validation

Integrate:

```text
RISC-V tests
Spike differential tests
```

Success:

```text
instruction semantics trusted
```

---

## Phase 3 — Exceptions + Privilege

Implement:

```text
M/S/U
traps
CSR
ecall
timer interrupts
```

Success:

```text
user code can trap into kernel
```

---

## Phase 4 — Physical Memory

Implement:

```text
page allocator
memory map
kernel heap
```

Success:

```text
physical pages allocate/free safely
```

---

## Phase 5 — MMU

Implement:

```text
page tables
Sv32-style translation
TLB
page faults
permissions
```

Success:

```text
isolated user address spaces
```

---

## Phase 6 — Kernel

Implement:

```text
processes
scheduler
context switching
syscalls
```

Success:

```text
multiple guest processes run
```

---

## Phase 7 — VFS

Implement:

```text
block device
brfs
VFS
file descriptors
```

Success:

```text
files persist during VM lifetime
```

---

## Phase 8 — Shell

Implement:

```text
brsh
commands
pipes
redirection
signals
jobs
```

Success:

```text
user can actually use BrowOS
```

---

## Phase 9 — Compiler + Assembler

Implement:

```text
BrowASM
BrowCC
ELF loader
libbrow
```

Success:

```text
write program inside BrowOS
compile
execute
```

---

## Phase 10 — Snapshot

Implement:

```text
BIMG
serialization
compression
import/export
```

Success:

```text
save → close → reopen → load
```

---

## Phase 11 — GPU

Implement:

```text
BrowGPU
command buffer
WebGPU
framebuffer
```

Success:

```text
guest app draws
```

---

## Phase 12 — Raytracer

Implement:

```text
compute shader
sphere
light
shadow
atmosphere
```

Success:

```text
gpu-demo
```

produces the globe.

---

## Phase 13 — AI

Implement:

```text
/dev/ai0
AI service
tiny model
WebGPU backend
Wasm fallback
```

Success:

```text
ai "hello"
```

works entirely locally.

---

## Phase 14 — Hardcore Features

Only now:

```text
COW
better scheduler
JIT
multicore
GPU memory virtualization
debugger
profiling
```

---

# 117. Phase Dependency Graph

The real dependency tree is:

```text
Browser Host
     │
     ▼
Wasm Runtime
     │
     ▼
RISC-V CPU
     │
     ├───────────────┐
     ▼               ▼
Privileged CPU      Memory
     │               │
     └──────┬────────┘
            ▼
           MMU
            │
            ▼
          Kernel
            │
     ┌──────┼──────────────┐
     ▼      ▼              ▼
 Scheduler VFS           Drivers
     │      │              │
     │      │        ┌─────┴─────┐
     │      │        ▼           ▼
     │      │      GPU          AI
     │      │
     └──────┴─────┐
                  ▼
                Userland
                  │
              ┌───┴────┐
              ▼        ▼
             Shell   Programs
```

---

# 118. What We Should NOT Build

Avoid these distractions initially:

```text
full TCP/IP stack
real network browser access
USB emulation
audio hardware
x86 compatibility
RV64
floating-point ISA
virtual BIOS graphics
full POSIX
full libc
ELF dynamic linking
shared libraries
swap
multicore
out-of-order CPU
instruction pipeline simulation
real disk filesystem persistence
```

They are cool.

They are also project killers.

---

# 119. Why Not Simulate a Pipelined CPU?

Because the goal is:

```text
functional CPU
```

not:

```text
microarchitectural research simulator
```

A five-stage pipeline is fun, but it offers little user-visible benefit and dramatically complicates:

```text
interrupts
exceptions
branch behavior
MMU interactions
debugging
```

A functional CPU is enough.

---

# 120. Why Not Out-of-Order?

Absolutely not in V1.

The browser is already emulating a CPU.

Adding an out-of-order pipeline means:

```text
rename tables
reservation stations
ROB
branch predictor
load/store queues
memory ordering
```

for zero practical BrowOS user benefit.

Save it for BrowOS-X.

---

# 121. Why RV32 Instead of ARM?

RISC-V has a cleaner publicly specified architecture, a strong educational ecosystem and useful official architectural tests.

The current RISC-V specification library is actively maintained, and RV32I is explicitly designed as a compiler/OS-friendly base ISA.

That makes it a very good target for a project whose whole point is exposing the internals.

---

# 122. Why Not Run Linux?

Because then the interesting part becomes:

```text
porting Linux
```

rather than:

```text
building BrowOS
```

BrowOS should have its own kernel and ABI.

The point is to understand and expose:

```text
CPU
MMU
kernel
scheduler
filesystem
devices
```

---

# 123. Why Not Use Existing Emulator Code Directly?

We should study existing emulators aggressively.

But borrowing an entire emulator would weaken the educational value.

v86 is particularly useful as a reference for architecture, browser integration, device virtualization and guest execution; it demonstrates that complex PC emulation can execute in-browser using WebAssembly.

Use these projects as:

```text
reference
test oracle
architecture inspiration
performance benchmark
```

not as an opaque black box.

---

# 124. Reference Projects to Study

### v86

Study:

```text
Wasm integration
memory model
browser worker model
JIT strategy
device emulation
debugging
```

v86 has successfully run multiple full operating systems in browsers and already uses WebAssembly-based translation for performance.

### Spike

Study:

```text
RISC-V semantics
CSRs
traps
MMU
reference behavior
```

Spike supports a very broad RISC-V feature set, making it useful as a verification oracle even though BrowOS will implement only a small subset.

### RISC-V ACT

Study:

```text
instruction tests
configuration
architectural correctness
```

The project explicitly describes itself as certification testing for faithful implementation of the specification.

### llama2.c

Study:

```text
minimal model runtime
tensor operations
model loading
CPU inference
```

It is intentionally tiny and educational.

### WebLLM / browser inference projects

Study:

```text
WebGPU execution
worker separation
model loading
quantization
```

Community browser inference projects demonstrate that meaningful local inference is feasible today, but performance and load times vary dramatically by hardware.

---

# 125. Community Reality Check

The community evidence strongly supports this project's feasibility, but with important caveats.

Browser-based full-machine emulation is already proven.

v86 runs complex x86 operating systems in browsers through WebAssembly.

OS developers have also discussed browser-hosted OS execution as a realistic client-side architecture, including TinyEMU/WebAssembly approaches.

WebAssembly threading is viable, but browser security headers matter.

Local GPU inference is feasible, with community examples ranging from tiny models to significantly larger quantized models, but weak GPUs can make performance poor.

Therefore:

```text
CPU + OS + filesystem + compiler:
        absolutely feasible

GPU ray tracer:
        absolutely feasible

tiny LLM:
        feasible

one HTML:
        feasible

one HTML + maximum parallel CPU performance:
        browser security model makes this conditional
```

That last distinction should be stated honestly in the project documentation.

---

# 126. The “Single HTML” Trick

The strongest release model is:

```text
                 browos.html
                      │
          ┌───────────┴───────────┐
          │                       │
      local mode              hosted mode
          │                       │
     single Worker         crossOriginIsolated
          │                       │
      Wasm CPU              SAB + Workers
          │                       │
      WebGPU                WebGPU
          │                       │
      AI fallback           accelerated AI
```

Thus the project never violates the single-file requirement.

The browser environment simply determines how aggressively BrowOS can parallelize.

---

# 127. Browser-Origin Problem Must Be Documented

The README should explicitly explain:

```text
Opening browos.html directly:
    compatibility mode

Serving browos.html with COOP/COEP:
    accelerated mode
```

This is not cheating.

It is respecting browser security architecture.

The final artifact is still one HTML file.

---

# 128. Recommended Demo Scenario

The final public demo should not begin with:

```text
hello world
```

It should begin with the boot sequence.

Then:

```text
BrowOS login:
```

User types:

```text
uname -a
```

then:

```text
ps
```

then:

```text
mem
```

then:

```text
cat /proc/cpuinfo
```

then:

```text
cc demo.c -o demo
./demo
```

then:

```text
stress &
top
```

then:

```text
gpu-demo globe
```

then:

```text
ai "explain how the BrowOS MMU works"
```

then:

```text
save snapshot.bimg
```

Then reload the HTML and:

```text
load snapshot.bimg
```

Now the user has effectively:

```text
booted a tiny computer
compiled software
ran concurrent processes
used virtual memory
used a filesystem
used a GPU
ran local AI
saved the whole machine
```

inside one HTML file.

That is the demo.

---

# 129. The “Crazy Screenshot” Target

The terminal should be able to display something like:

```text
╔══════════════════════════════════════════════════════════════╗
║ BROWOS SYSTEM MONITOR                                      ║
╠══════════════════════════════════════════════════════════════╣
║ CPU       RV32IM     8.7 MIPS                              ║
║ RAM       256 MiB    73 MiB used                          ║
║ DISK      256 MiB    41 MiB used                          ║
║ MMU       Sv32       TLB 94.2%                             ║
║ TASKS     17         RUNNING 1                            ║
║ GPU       WebGPU     1280×720                              ║
║ AI        READY      18.4 tok/s                            ║
╠══════════════════════════════════════════════════════════════╣
║ PID   STATE       CPU       COMMAND                         ║
║ 1     SLEEPING    0.1%      init                            ║
║ 2     RUNNING     54.2%     gpu-demo                        ║
║ 3     READY       23.4%     stress                          ║
║ 4     SLEEPING    0.0%      ai-server                       ║
╚══════════════════════════════════════════════════════════════╝
```

That communicates the engineering much more effectively than a generic terminal screenshot.

---

# 130. Project Milestones

## M0

```text
single HTML
terminal
```

## M1

```text
RV32I CPU
```

## M2

```text
RV32IM + traps
```

## M3

```text
MMU + U/S/M modes
```

## M4

```text
kernel + processes
```

## M5

```text
scheduler + syscalls
```

## M6

```text
filesystem
```

## M7

```text
shell
```

## M8

```text
assembler
```

## M9

```text
compiler
```

## M10

```text
snapshot system
```

## M11

```text
GPU
```

## M12

```text
ray tracing
```

## M13

```text
AI
```

## M14

```text
JIT
```

## M15

```text
multicore experimental mode
```

---

# 131. “Done” Definition

BrowOS is genuinely successful when the following sequence works:

```text
OPEN browos.html

        ↓

BOOTLOADER

        ↓

KERNEL

        ↓

INIT

        ↓

SHELL

        ↓

$ cat > hello.c

        ↓

BrowCC compiles it

        ↓

ELF loader loads it

        ↓

RV32IM executes it

        ↓

syscalls enter kernel

        ↓

scheduler switches processes

        ↓

filesystem provides files

        ↓

MMU protects address spaces

        ↓

GPU device accepts commands

        ↓

WebGPU renders globe

        ↓

AI service performs local inference

        ↓

save snapshot.bimg

        ↓

close page

        ↓

open browos.html

        ↓

load snapshot.bimg

        ↓

machine continues
```

At that point this stops being a frontend gimmick.

It becomes a legitimate **browser-hosted virtual computer**.

---

# 132. Final Recommended Architecture

```text
                         ┌───────────────────────┐
                         │       browos.html     │
                         │                       │
                         │ HTML / CSS / JS       │
                         │ embedded Wasm         │
                         │ shaders               │
                         │ default disk image    │
                         └───────────┬───────────┘
                                     │
                         ┌───────────▼───────────┐
                         │    Browser Host       │
                         │                       │
                         │ UI / Input / Files    │
                         │ WebGPU / WebGL2       │
                         │ Worker management     │
                         └───────────┬───────────┘
                                     │
                              Worker boundary
                                     │
                  ┌──────────────────▼──────────────────┐
                  │            BrowOS Machine            │
                  │                                      │
                  │              RV32IM                   │
                  │          M / S / U modes              │
                  │                                      │
                  │        ┌───────────────┐              │
                  │        │     MMU       │              │
                  │        │ TLB / Sv32    │              │
                  │        └───────┬───────┘              │
                  │                │                      │
                  │        ┌───────▼───────┐              │
                  │        │ Physical RAM  │              │
                  │        └───────────────┘              │
                  │                                      │
                  │              KERNEL                   │
                  │       ┌──────┬───────┬──────┐          │
                  │       │sched │ VFS   │ IPC  │          │
                  │       └──────┴───────┴──────┘          │
                  │                                      │
                  │             DRIVERS                    │
                  │       ┌────┬─────┬─────┬─────┐         │
                  │       │TTY │timer│blk  │GPU  │         │
                  │       └────┴─────┴─────┴─────┘         │
                  │                                      │
                  │             USERSPACE                 │
                  │        init / shell / apps             │
                  │                                      │
                  │       compiler / assembler             │
                  │                                      │
                  └──────────────────┬───────────────────┘
                                     │
                       ┌─────────────┴─────────────┐
                       │                           │
                  ┌────▼─────┐               ┌─────▼────┐
                  │ WebGPU   │               │ AI       │
                  │ BrowGPU  │               │ Runtime  │
                  └──────────┘               └──────────┘
```

---

# 133. The Rules We Should Never Break

1. **The browser is the host, not the OS.**

2. **Guest code must execute as guest code.**

3. **JavaScript must not secretly replace the kernel.**

4. **The CPU must be implemented as a real RISC-V functional model.**

5. **Memory protection must be implemented through actual page translation and permissions.**

6. **Processes must have real isolated state.**

7. **Scheduling must happen inside BrowOS.**

8. **Filesystem operations must go through the VFS/device path.**

9. **GPU rendering must go through the BrowGPU abstraction.**

10. **AI must be a device/service, not a hidden API call.**

11. **Browser APIs belong behind host/device boundaries.**

12. **Performance optimizations come after correctness.**

13. **Every optimized subsystem keeps a simple reference implementation.**

14. **Debug mode must make the entire machine observable.**

15. **The final distribution remains one HTML file.**

---

# 134. The Final Technical Position

BrowOS is feasible.

The difficult pieces are not:

```text
HTML
JavaScript
WebAssembly
```

Those are mature.

The difficult pieces are:

```text
1. building a correct RISC-V core
2. building a correct MMU/trap subsystem
3. maintaining guest/host memory boundaries
4. getting a usable compiler and ELF loader
5. achieving high guest-instruction throughput
6. integrating GPU workloads without destroying VM responsiveness
7. packaging everything into a genuinely self-contained artifact
```

The browser platform has already demonstrated that serious emulation and local compute are possible: v86 performs full PC emulation with WebAssembly translation; WebAssembly supports shared-memory threading under the appropriate browser security model; WebGPU exposes compute pipelines; and modern browser projects demonstrate local WebGPU/Wasm inference.

The key is **architecture discipline**.

BrowOS should therefore be built as:

```text
REAL CPU
+
REAL PRIVILEGE MODES
+
REAL MMU
+
REAL PROCESSES
+
REAL SCHEDULER
+
REAL SYSCALLS
+
REAL VFS
+
REAL USERLAND
+
REAL COMPILER
+
REAL GPU DRIVER
+
REAL LOCAL AI SERVICE
+
REAL SNAPSHOT SYSTEM
```

with:

```text
JavaScript
    = browser motherboard

WebAssembly
    = low-level machine substrate

RISC-V
    = guest CPU architecture

BrowOS
    = guest operating system

WebGPU
    = physical accelerator

HTML
    = complete physical machine package
```

That is the architecture worth pursuing.

---

# 135. Primary Technical References

### RISC-V

* RISC-V RV32I specification — the base ISA definition and rationale.
* RISC-V privileged architecture — M/S/U privilege model and OS-facing architecture.
* RISC-V Architectural Certification Tests — architecture compliance testing.
* RISC-V Spike ISA Simulator — useful differential/reference implementation.

### WebAssembly

* WebAssembly JavaScript API / linear memory model.
* WebAssembly threads and shared memory.

### Browser concurrency

* MDN `crossOriginIsolated`, SharedArrayBuffer and security requirements.
* COOP/COEP requirements.

### GPU

* WebGPU specification / compute pipelines.
* WebGL framebuffer support.

### Browser emulation

* v86 — mature browser PC emulator using WebAssembly/JIT techniques.

### AI

* llama2.c — minimal C Llama inference implementation and tiny model.
* llama.cpp WebGPU browser work.
* Recent browser-local WebGPU/Wasm inference community examples.

### Community / OSDev

* Browser-hosted OS/emulator discussions.
* Scheduler design discussions emphasizing simple ready queues and incremental complexity.

---

# 136. The One Sentence That Defines BrowOS

> **BrowOS is a complete tiny virtual computer implemented inside one HTML file, where JavaScript is the host, WebAssembly is the machine substrate, RISC-V is the CPU, BrowOS is the operating system, WebGPU is the accelerator, and the browser is nothing more than the physical machine we stole.**

That is the project.
