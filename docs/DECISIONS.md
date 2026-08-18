# BrowOS — Engineering Decision Log

> Per AGENT.md §65: record significant architectural decisions so solved questions are not reopened.
> Latest entries first.

## D9 — Instruction/Data alignment model (M1)

**Decision:** Misaligned loads/stores raise misaligned access faults (cause 4/6) in all
modes; MMIO accesses must be naturally aligned (else access fault cause 5/7). No
misaligned-access emulation.

**Reason:** Matches the privileged spec default; simplest correct behavior.

**Alternatives:** Emulating misaligned accesses in M-mode (deferred; YAGNI).

## D8 — Version identifiers (M0)

| Component    | Version |
|--------------|---------|
| BrowOS kernel (bootstrap supervisor) | 0.1 |
| BrowOS ABI | 1 |
| BIMG format | 1 (unimplemented until M10) |
| BrowGPU API | 1 (unimplemented until M11) |
| BrowAI API | 1 (unimplemented until M13) |

## D7 — Memory map (finalized before driver work, per PLAN.md §2)

```text
0x00000000 ──────────────────────── RAM (256 MiB default, configurable)
            |
            | 0x00000000..0x0000FFFF  reserved (boot/firmware/trap data)
            | 0x00010000..            user programs (ELF vaddr base)
            | 0x0F000000              user stack top (grows down)
            |
0x10000000 ──────────────────────── UART (16 B)
0x10001000 ──────────────────────── TIMER (16 B)
0x10002000 ──────────────────────── INTC (16 B)
0x10006000 ──────────────────────── RNG (8 B)
0x1000FFFF ──────────────────────── MMIO window end (reserved)
```

The classic `0x80000000` RISC-V kernel address is NOT used: guest RAM ends at
`0x0FFFFFFF` (256 MiB), so programs live in low physical memory. Kernel *virtual*
high mapping arrives with the MMU milestone (M3).

Device register maps (documented in each driver):

- **UART** (0x10000000): `0x00 TXDATA` (write), `0x04 RXDATA` (read, 0xFFFFFFFF if
  empty), `0x08 TXSTATUS` (bit0 busy), `0x0C RXSTATUS` (bit0 data available),
  `0x10 INTCTRL` (bit0 rx-irq enable), `0x14 INTSTAT` (read = rx pending; clears).
- **TIMER** (0x10001000): `0x00 TIME` (read), `0x04 TIMECMP` (write), `0x08 CTRL`
  (bit0 enable, bit1 irq-enable), `0x0C CLEARIRQ` (write 1 clears pending).
- **INTC** (0x10002000): `0x00 PEND` (read), `0x04 ENABLE` (write mask),
  `0x08 FORCE` (write bits set lines), `0x0C CLEAR` (write bits clear lines).
  Lines: bit0 = timer, bit1 = uart-rx. All device IRQs fold into one CPU line:
  **machine external interrupt (MEIP, cause 11)** — MTIP/STIP delivery is deferred.
- **RNG** (0x10006000): `0x00 RNGDATA` (read, PRNG u32), `0x04 RNGSEED` (write).

## D6 — Interrupt model (M1)

**Decision:** All device IRQs go through the INTC, which drives a single MEIP line.
Timer compare and UART RX pending map to INTC lines. MTIP/STIP timer-delegation
paths are not implemented yet.

**Reason:** PLAN.md §20 wants a real interrupt-controller path
(device → INTC → pending → CPU trap). One external line keeps the first interrupt
implementation tractable; PLIC-style bit-per-interrupt delivery can come later.

## D5 — Bootstrap supervisor runs in JS inside the VM worker (M0/M1)

**Decision:** For the bootstrap milestones the kernel's trap handling, scheduling
and syscalls are implemented as a privileged JS callback (`Supervisor`) executing
inside the VM worker — never on the main thread, never bypassing the CPU.

**Explicitly NOT faked:** guest processes are real RISC-V machine code; ecall
traps are real; the trap path (mstatus/MPP/SPIE, stvec/sepc/scause) is real;
syscall dispatch is real; the UART output path is real.

**Why:** A guest-resident kernel requires the C compiler (M9). This keeps every
real mechanism live while the kernel is ported to guest RISC-V once BrowCC works.

**Alternatives:** Writing the whole kernel in hand-assembled RISC-V now (rejected:
no compiler yet, slows the vertical slice dramatically).

## D4 — Execution profile

**Decision:** Profile A (PLAN.md §5): everything runs in a single Web Worker
(created from a Blob so `file://` works). Message passing between UI and worker.
No SharedArrayBuffer, no cross-origin isolation requirement.

**Why:** Works when opening `browos.html` directly from disk. SAB/accelerated
profile is a later milestone.

## D3 — Core implementation language

**Decision:** JavaScript (CommonJS modules) for the core VM: CPU, MMU, kernel,
drivers, filesystem. Node's built-in test runner provides zero-dependency tests
running the *exact same module files* the browser bundle embeds.

**Why:** No Rust/Clang toolchain on the development machine; JS needs none.
Correctness-first (AGENT.md §20): the JS interpreter is the reference
implementation. WebAssembly port is a later performance milestone behind the
same interfaces (PLAN.md §32, §67).

**Alternatives:** Rust→Wasm (PLAN.md §76's recommendation). Rejected for now:
toolchain install burden, JS↔Wasm boundary complexity, slower vertical slice.
Documented; revisit when performance demands it.

## D2 — Memory sizing

**Decision:** Default guest RAM 256 MiB, default virtual disk 256 MiB
(configurable via `?ram=` / `?disk=` later in hosted mode, PLAN.md §105–106).
On host allocation failure, retry at 64 MiB and report (AGENT.md §38).

## D1 — Syscall ABI

**Decision:** Linux-style RISC-V syscall numbers (`write=64`, `exit=93`,
`read=63`), a7 = number, a0–a5 = args, negative errno returns in a0
(AGENT.md §56 centralizes these in `src/abi/syscall.js`).

**Why:** Familiar, well-documented conventions; the eventual C compiler and
libbrow can map cleanly. Not POSIX-complete — a coherent BrowOS ABI v1.

## D0 — Plan adjustments from PLAN.md

**Decision:** PLAN.md recommends Rust (PLAN.md §76) — see D3. Everything else
follows PLAN.md's architecture: RV32IM, M/S/U, Sv32-style MMU later, single-HTML
distribution, Profile A execution, vertical-slice build order.
