# BrowOS

A complete tiny virtual computer implemented inside **one HTML file**.

- RISC-V **RV32IM** CPU (M/S/U privilege modes)
- Real MMU/traps, kernel, scheduler, processes, syscalls
- RAM-backed filesystem, shell, assembler, compiler
- Virtual GPU (WebGPU) and local AI — later phases
- Snapshot save/load — later phase

The browser is the machine room. BrowOS is the computer. (PLAN.md is the
architecture contract; AGENT.md is the engineering discipline.)

## Current status

**Milestone M0–M2 (bootable vertical slice)** — implemented:

- Single HTML boots offline (`file://` supported, Profile A execution)
- RV32IM CPU: full decoder, M extension, M/S/U traps, CSR subset
- Physical memory (256 MiB default), MMIO bus, UART / TIMER / INTC / RNG devices
- Bootstrap supervisor: real ecall → S-mode trap → syscall → UART → terminal
- First guest program (`/bin/hello`, a real RISC-V ELF assembled by our
  host-side assembler) runs and exits cleanly
- Node test suite (`node --test`) covering assembler, decoder, CPU semantics,
  traps, bus, ELF loader, and full machine boot

Not yet implemented (roadmap): Sv32 MMU (M3), processes/scheduler (M4–M5),
brfs filesystem (M6–M7), guest shell (M8), assembler/compiler in guest (M9),
snapshots (M10), GPU/raytracer (M11–M12), AI (M13).

## Browser-origin note (PLAN.md §127)

- **Opening `browos.html` directly from disk**: universal/compatibility mode —
  single VM worker, message passing. Works in Chromium and Firefox.
- **Serving `browos.html` with COOP/COEP headers**: accelerated mode becomes
  possible later (SharedArrayBuffer, multi-worker) — a future milestone.

This is not a flaw; it is the browser security boundary. The artifact is one
file either way.

## Build & test

```sh
npm test        # assembler/CPU/trap/bus/ELF/machine tests (Node, no deps)
npm run build   # produce dist/browos.html (deterministic bundle)
npm run smoke   # headless boot: assemble hello.s, boot machine, assert output
npm run check   # all of the above
```

Then open `dist/browos.html` in a browser.

## Repository layout

```text
src/            shared machine modules (browser + Node, CommonJS)
  abi/          syscall numbers, errors (single source of truth)
  cpu/          decoder, execute, CSRs, trap logic, CPU
  machine/      RAM, bus, ELF loader, machine assembly
  drivers/      uart, timer, intc, rng
  kernel/       bootstrap supervisor
guestsrc/       guest programs (assembly source)
tools/          host-side assembler, build script, smoke test
tests/          node --test suites
web/            terminal renderer, host bridge, worker, HTML template
docs/           decision log
dist/           generated single-file artifact (never hand-edited)
```

## License

Unspecified (internal project).
