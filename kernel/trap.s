# trap.s - Trap Handling, Interrupts, and Context Switching.

.section .data
.align 4
.global kernel_trap_sp
kernel_trap_sp: .word 0

.section .text
.align 4
.global trap_init
.global trap_entry
.global trap_handler
.global context_switch

# trap_init(): Configures trap delegation and vectors.
trap_init:
  # Set stvec to trap_entry
  la t0, trap_entry
  csrw stvec, t0

  # Delegate exceptions (ecall U, page faults, misaligned) to S-mode: medeleg
  # Bits: ecall_u(8), fetch_pf(12), load_pf(13), store_pf(15), illegal(2), breakpoint(3)
  li t0, 0xB10C
  csrw medeleg, t0

  # Delegate interrupts to S-mode: mideleg (STIP bit 5, SSIP bit 1)
  li t0, 0x0022
  csrw mideleg, t0

  # Enable S-mode interrupts in sie: STIE (bit 5)
  li t0, 0x0020
  csrw sie, t0

  # Permit supervisor mode to access user memory (sstatus.SUM = 1, bit 18)
  li t0, 0x00040000
  csrs sstatus, t0

  ret

# trap_entry: Low-level interrupt/exception entry point.
.align 4
trap_entry:
  # Swap sp with sscratch to get process trapframe
  csrrw sp, sscratch, sp
  bnez sp, trap_from_user

  # If sscratch was 0, trap was from kernel mode, restore sp
  csrrw sp, sscratch, sp
  addi sp, sp, -144
  j trap_save_regs

trap_from_user:
  # sp now points to trapframe
trap_save_regs:
  # Save general registers (x1..x31)
  sw x1, 4(sp)
  # Save original sp from sscratch into tf.sp (offset 8)
  csrr t0, sscratch
  sw t0, 8(sp)
  sw x3, 12(sp)
  sw x4, 16(sp)
  sw x5, 20(sp)
  sw x6, 24(sp)
  sw x7, 28(sp)
  sw x8, 32(sp)
  sw x9, 36(sp)
  sw x10, 40(sp)
  sw x11, 44(sp)
  sw x12, 48(sp)
  sw x13, 52(sp)
  sw x14, 56(sp)
  sw x15, 60(sp)
  sw x16, 64(sp)
  sw x17, 68(sp)
  sw x18, 72(sp)
  sw x19, 76(sp)
  sw x20, 80(sp)
  sw x21, 84(sp)
  sw x22, 88(sp)
  sw x23, 92(sp)
  sw x24, 96(sp)
  sw x25, 100(sp)
  sw x26, 104(sp)
  sw x27, 108(sp)
  sw x28, 112(sp)
  sw x29, 116(sp)
  sw x30, 120(sp)
  sw x31, 124(sp)

  # Save CSRs: sepc, sstatus, scause, stval
  csrr t0, sepc
  sw t0, 128(sp)
  csrr t0, sstatus
  sw t0, 132(sp)
  csrr t0, scause
  sw t0, 136(sp)
  csrr t0, stval
  sw t0, 140(sp)

  # Save trapframe pointer in s0
  mv s0, sp

  # Switch to kernel stack
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, trap_use_default_stack
  lw sp, 20(t1)  # pcb.kstack
  j trap_do_call
trap_use_default_stack:
  la sp, stack_top
trap_do_call:
  mv a0, s0      # a0 = tf
  call trap_handler

  # Check pending signals while on kernel stack
  la t0, current_proc
  lw a0, 0(t0)
  beqz a0, trap_no_sig
  call sig_check_deliver
trap_no_sig:

  # Restore sp = tf
  mv sp, s0
  j trap_return

# trap_return: Restores registers from trapframe and executes sret.
.global trap_return
trap_return:
  # Restore CSRs
  lw t0, 128(sp)
  csrw sepc, t0
  lw t0, 132(sp)
  csrw sstatus, t0

  # Restore general registers
  lw x1, 4(sp)
  lw x3, 12(sp)
  lw x4, 16(sp)
  lw x5, 20(sp)
  lw x6, 24(sp)
  lw x7, 28(sp)
  lw x8, 32(sp)
  lw x9, 36(sp)
  lw x10, 40(sp)
  lw x11, 44(sp)
  lw x12, 48(sp)
  lw x13, 52(sp)
  lw x14, 56(sp)
  lw x15, 60(sp)
  lw x16, 64(sp)
  lw x17, 68(sp)
  lw x18, 72(sp)
  lw x19, 76(sp)
  lw x20, 80(sp)
  lw x21, 84(sp)
  lw x22, 88(sp)
  lw x23, 92(sp)
  lw x24, 96(sp)
  lw x25, 100(sp)
  lw x26, 104(sp)
  lw x27, 108(sp)
  lw x28, 112(sp)
  lw x29, 116(sp)
  lw x30, 120(sp)
  lw x31, 124(sp)

  # Setup sscratch with trapframe address for next trap
  csrw sscratch, sp

  # Restore user sp
  lw sp, 8(sp)

  sret

# trap_handler(a0=tf): High-level trap dispatcher.
trap_handler:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)

  mv s0, a0  # tf pointer

  lw t0, 136(s0)  # scause

  # Check if ECALL from U-mode (cause 8)
  li t1, 8
  beq t0, t1, trap_handle_syscall

  # Check if Timer Interrupt (cause 0x80000005)
  li t1, 0x80000005
  beq t0, t1, trap_handle_timer

  # Check if Page Fault (causes 12, 13, 15)
  li t1, 12
  beq t0, t1, trap_handle_pagefault
  li t1, 13
  beq t0, t1, trap_handle_pagefault
  li t1, 15
  beq t0, t1, trap_handle_pagefault

  # Other exception: terminate process
  li a0, -1
  call proc_exit
  j trap_handler_done

trap_handle_syscall:
  # Advance sepc past ecall (sepc += 4)
  lw t2, 128(s0)
  addi t2, t2, 4
  sw t2, 128(s0)

  # Syscall args: a7=tf.x17, a0=tf.x10, a1=tf.x11, a2=tf.x12, a3=tf.x13
  lw a7, 68(s0)  # TF_A7
  lw a0, 40(s0)  # TF_A0
  lw a1, 44(s0)  # TF_A1
  lw a2, 48(s0)  # TF_A2
  lw a3, 52(s0)  # TF_A3
  lw a4, 56(s0)  # TF_A4
  lw a5, 60(s0)  # TF_A5

  call syscall_dispatch

  # Save return value into tf.a0 (offset 40)
  sw a0, 40(s0)
  j trap_handler_done

trap_handle_timer:
  call scheduler_tick
  j trap_handler_done

trap_handle_pagefault:
  li a0, -2
  call proc_exit

trap_handler_done:
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# context_switch(a0=prev_pcb, a1=next_pcb)
# Switches address space, updates current_proc, and jumps to next process.
context_switch:
  la t0, current_proc
  sw a1, 0(t0)

  # Mark next process RUNNING
  li t1, 2  # PROC_RUNNING
  sw t1, 0(a1)

  # Switch address space (satp)
  lw a0, 16(a1)  # next_pcb.satp
  call vmm_switch

  # Set sp to next_pcb.tf and return to user mode
  lw sp, 28(a1)  # next_pcb.tf
  j trap_return
