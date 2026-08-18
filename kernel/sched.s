# sched.s - Preemptive Multi-Level Round-Robin Scheduler.

.section .data
.align 4
.global sched_current_idx
sched_current_idx: .word 0

.section .text
.align 2
.global scheduler_init
.global scheduler_tick
.global schedule
.global sys_yield

scheduler_init:
  la t0, sched_current_idx
  sw x0, 0(t0)
  ret

# scheduler_tick(): Invoked on timer interrupt tick.
scheduler_tick:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)

  # Wake up sleeping processes
  la s0, proc_table
  li t0, 0
  li t1, 16  # MAX_PROCS
sched_sleep_scan:
  lw t2, 0(s0)  # state
  li t3, 3      # PROC_SLEEPING
  bne t2, t3, sched_sleep_next

  lw t4, 36(s0) # pcb.sleep_ticks
  blez t4, sched_wake_proc
  addi t4, t4, -1
  sw t4, 36(s0)
  bgtz t4, sched_sleep_next

sched_wake_proc:
  li t2, 1      # PROC_RUNNABLE
  sw t2, 0(s0)

sched_sleep_next:
  addi s0, s0, 40  # PCB_SIZE
  addi t0, t0, 1
  blt t0, t1, sched_sleep_scan

  # Round-robin schedule
  call schedule

  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# schedule(): Selects the next runnable process and switches to it.
schedule:
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)

  la t0, sched_current_idx
  lw s0, 0(t0)  # start index
  la s1, proc_table
  li s2, 0      # scan counter

sched_search_loop:
  addi s0, s0, 1
  andi s0, s0, 15  # modulo 16

  slli t1, s0, 5   # s0 * 32
  slli t2, s0, 3   # s0 * 8
  add t1, t1, t2   # s0 * 40 (PCB_SIZE)
  add t3, s1, t1   # target PCB address

  lw t4, 0(t3)     # pcb.state
  li t5, 1         # PROC_RUNNABLE
  beq t4, t5, sched_found_process

  addi s2, s2, 1
  li t6, 16
  blt s2, t6, sched_search_loop

  # No other runnable process found
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sched_idle

  # Current process can keep running if RUNNING
  lw t2, 0(t1)
  li t3, 2  # PROC_RUNNING
  beq t2, t3, sched_done

sched_idle:
  # Check if kmain is waiting for all processes to complete
  la t0, kmain_saved_sp
  lw s0, 0(t0)
  beqz s0, sched_done

  # Clear kmain_saved_sp and current_proc
  sw x0, 0(t0)
  la t2, current_proc
  sw x0, 0(t2)

  # Switch satp back to kernel root
  la t0, vmm_kernel_root
  lw a0, 0(t0)
  call vmm_switch

  # Restore sp to kmain stack and resume kmain!
  mv sp, s0
  j kmain_sched_returned

sched_found_process:
  # Update index
  la t0, sched_current_idx
  sw s0, 0(t0)

  # Check current process
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sched_switch_now

  lw t2, 0(t1)
  li t4, 2  # PROC_RUNNING
  bne t2, t4, sched_switch_now
  # Change current process state from RUNNING to RUNNABLE
  li t4, 1  # PROC_RUNNABLE
  sw t4, 0(t1)

sched_switch_now:
  # Switch to target PCB at t3
  mv a0, t1  # prev_pcb
  mv a1, t3  # next_pcb
  call context_switch

sched_done:
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

# sys_yield(): Voluntarily relinquishes the CPU.
sys_yield:
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sys_yield_ret

  li t2, 1  # PROC_RUNNABLE
  sw t2, 0(t1)
  call schedule

sys_yield_ret:
  li a0, 0
  ret
