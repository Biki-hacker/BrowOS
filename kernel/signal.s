# signal.s - Signal Handling and Delivery Subsystem for BrowOS.

.section .text
.align 2
.global sig_send
.global sig_check_deliver
.global sys_kill

# sig_send(a0=target_pcb, a1=sig): Sends a signal to a process.
sig_send:
  beqz a0, sig_send_err
  li t0, 32
  bgeu a1, t0, sig_send_err

  # Check fatal signals: SIGKILL (9), SIGTERM (15), SIGINT (2)
  li t0, 9
  beq a1, t0, sig_send_kill
  li t0, 15
  beq a1, t0, sig_send_kill
  li t0, 2
  beq a1, t0, sig_send_kill

  # Non-fatal signal: set bit in sig_pending
  li t1, 1
  sll t1, t1, a1
  slli t1, t1, 16
  lw t2, 36(a0)
  or t2, t2, t1
  sw t2, 36(a0)

  # If target is SLEEPING (3), wake up to RUNNABLE (1)
  lw t3, 0(a0)
  li t4, 3  # PROC_SLEEPING
  bne t3, t4, sig_send_done
  li t4, 1  # PROC_RUNNABLE
  sw t4, 0(a0)
  j sig_send_done

sig_send_kill:
  # Check if target is current_proc
  la t0, current_proc
  lw t1, 0(t0)
  beq a0, t1, sig_kill_self

  # Target is another process: immediately zombify with exitcode = -sig
  li t2, 4       # PROC_ZOMBIE
  sw t2, 0(a0)
  sub t3, x0, a1 # -sig
  sw t3, 32(a0)  # pcb.exitcode
  li a0, 0
  ret

sig_kill_self:
  sub a0, x0, a1 # -sig
  j proc_exit

sig_send_done:
  li a0, 0
  ret

sig_send_err:
  li a0, -1
  ret

# sig_check_deliver(a0=pcb): Checks and delivers pending signals before returning to U-mode.
sig_check_deliver:
  beqz a0, sig_check_done

  lw t0, 36(a0)
  srli t0, t0, 16     # extract sigmask from high 16 bits
  beqz t0, sig_check_done

  # Check SIGKILL (bit 9), SIGINT (bit 2), SIGTERM (bit 15)
  li t1, 0x8204       # (1<<9) | (1<<2) | (1<<15) = 0x200 | 0x004 | 0x8000 = 0x8204
  and t2, t0, t1
  beqz t2, sig_check_done

  # Clear pending signals
  lw t3, 36(a0)
  li t4, 0xFFFF
  and t3, t3, t4
  sw t3, 36(a0)

  # Terminate process with exit code -9 (Killed)
  li a0, -9
  j proc_exit

sig_check_done:
  ret

# sys_kill(a0=pid, a1=sig): System call 17.
sys_kill:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  mv s0, a0           # pid
  mv s1, a1           # sig

  # Find PCB in proc_table
  la t0, proc_table
  li t1, 0
  li t2, 16           # MAX_PROCS
sys_kill_scan:
  lw t3, 0(t0)        # pcb.state
  beqz t3, sys_kill_next
  lw t4, 4(t0)        # pcb.pid
  beq t4, s0, sys_kill_found
sys_kill_next:
  addi t0, t0, 44     # PCB_SIZE
  addi t1, t1, 1
  blt t1, t2, sys_kill_scan

  # PID not found -> ESRCH (-1)
  li a0, -1
  j sys_kill_ret

sys_kill_found:
  mv a0, t0           # target PCB
  mv a1, s1           # sig
  call sig_send

sys_kill_ret:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret
