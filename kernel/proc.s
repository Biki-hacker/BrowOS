# proc.s - Process Control Block (PCB) and Process Table Management.

.section .data
.align 4
.global proc_table
.global current_proc
.global next_pid

proc_table:   .zero 704  # 16 PCBs * 44 bytes
current_proc: .word 0
next_pid:     .word 1

.section .text
.align 2
.global proc_init
.global proc_alloc
.global proc_create
.global proc_exit

# proc_init(): Clears the process table and resets PID counter.
proc_init:
  la t0, proc_table
  li t1, 0
  li t2, 176  # 704 bytes / 4 = 176 words
proc_init_loop:
  sw x0, 0(t0)
  addi t0, t0, 4
  addi t1, t1, 1
  blt t1, t2, proc_init_loop

  la t0, next_pid
  li t1, 1
  sw t1, 0(t0)

  la t0, current_proc
  sw x0, 0(t0)
  ret

# proc_alloc(): Finds an unused PCB and allocates its resources.
# Returns a0 = pcb_ptr (or 0 if no slots).
proc_alloc:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)

  la s0, proc_table
  li s1, 0
proc_alloc_search:
  lw t0, 0(s0)  # pcb.state (offset 0)
  beqz t0, proc_alloc_found
  addi s0, s0, 44  # PCB_SIZE
  addi s1, s1, 1
  li t1, 16        # MAX_PROCS
  blt s1, t1, proc_alloc_search

  # Table full
  li a0, 0
  j proc_alloc_done

proc_alloc_found:
  # Found slot at s0
  li t0, 1  # PROC_RUNNABLE
  sw t0, 0(s0)

  # Assign PID
  la t1, next_pid
  lw t2, 0(t1)
  sw t2, 4(s0)  # pcb.pid
  addi t3, t2, 1
  sw t3, 0(t1)

  # Allocate kernel stack (512 bytes from heap)
  li a0, 512
  call kmalloc
  addi a0, a0, 500  # Stack grows down
  sw a0, 20(s0)     # pcb.kstack

  # Allocate trapframe (144 bytes from heap)
  li a0, 144
  call kmalloc
  sw a0, 28(s0)     # pcb.tf

  sw x0, 40(s0)     # pcb.cwd = 0 (root)

  mv a0, s0

proc_alloc_done:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# proc_create(a0=entry_fn, a1=priority): Creates a new U-mode process.
# Returns a0 = pcb_ptr
proc_create:
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)

  mv s1, a0  # entry_fn
  mv s2, a1  # priority

  call proc_alloc
  beqz a0, proc_create_fail
  mv s0, a0  # pcb_ptr

  sw s2, 12(s0)  # pcb.priority

  # Create address space
  call vmm_create_space
  mv s3, a0      # root_pa
  sw s3, 16(s0)  # pcb.satp

  # Allocate user stack physical page
  call alloc_frame
  mv s4, a0      # ustack_pa

  # Map user stack at VA USER_STACK_VA (User Data: R | W | U | A | D)
  mv a0, s3
  li a1, USER_STACK_VA
  mv a2, s4
  li a3, PTE_USER_DATA # 0xD7
  call vmm_map_page

  # Allocate user code physical page
  call alloc_frame
  mv s4, a0      # ucode_pa

  # Copy 256 bytes (64 words) from entry_fn (s1) to ucode_pa (s4)
  li t0, 0
  li t1, 64
proc_copy_ucode:
  slli t2, t0, 2
  add t3, s1, t2
  lw t4, 0(t3)
  add t3, s4, t2
  sw t4, 0(t3)
  addi t0, t0, 1
  blt t0, t1, proc_copy_ucode

  # Map user code page at VA 0x40000000 (User Text: R | X | U | A | D)
  mv a0, s3
  li a1, 0x40000000
  mv a2, s4
  li a3, PTE_USER_TEXT # 0xDB
  call vmm_map_page

  # Initialize trapframe
  lw t0, 28(s0)  # pcb.tf
  # Zero trapframe
  li t1, 0
  li t2, 36
proc_zero_tf:
  slli t3, t1, 2
  add t4, t0, t3
  sw x0, 0(t4)
  addi t1, t1, 1
  blt t1, t2, proc_zero_tf

  # Set tf.epc = 0x40000000 (offset 128)
  li t1, 0x40000000
  sw t1, 128(t0)
  # Set tf.sp = USER_STACK_TOP (offset 8)
  li t1, USER_STACK_TOP
  sw t1, 8(t0)
  # Set tf.sstatus = MSTATUS_SPIE (0x20) | SUM (0x40000) = 0x40020 (offset 132, U-mode on sret, SUM=1)
  li t1, 0x40020
  sw t1, 132(t0)

  mv a0, s0
  j proc_create_done

proc_create_fail:
  li a0, 0

proc_create_done:
  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

# proc_exit(a0=exit_code): Terminates current process.
proc_exit:
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, proc_exit_halt

  # Mark ZOMBIE
  li t2, 4  # PROC_ZOMBIE
  sw t2, 0(t1)
  sw a0, 32(t1)  # pcb.exitcode

  # Call scheduler to switch away
  call schedule

proc_exit_halt:
  # Loop if nothing left to run
  wfi
  j proc_exit_halt

# sys_fork(): Clones current process into a new child process.
# Returns child PID in parent, or 0 in child (or -1 on error).
.global sys_fork
sys_fork:
  addi sp, sp, -28
  sw ra, 24(sp)
  sw s0, 20(sp)
  sw s1, 16(sp)
  sw s2, 12(sp)
  sw s3, 8(sp)
  sw s4, 4(sp)

  la t0, current_proc
  lw s0, 0(t0)        # s0 = parent PCB
  beqz s0, sys_fork_fail

  # Allocate child PCB
  call proc_alloc
  beqz a0, sys_fork_fail
  mv s1, a0           # s1 = child PCB

  # Set parent_pid
  lw t1, 4(s0)        # parent.pid
  sw t1, 8(s1)        # child.parent_pid (PCB_PPID = 8)
  lw t2, 12(s0)       # parent.priority
  sw t2, 12(s1)       # child.priority (PCB_PRIORITY = 12)

  # Create new address space for child
  call vmm_create_space
  sw a0, 16(s1)       # child.satp = child_root_pa
  mv s2, a0           # s2 = child_root_pa

  # Clone user text/data page (0x40000000)
  call alloc_frame
  beqz a0, sys_fork_fail
  mv s3, a0           # s3 = child_text_frame
  # Copy 4096 bytes from 0x40000000 to child_text_frame
  mv a0, s3
  li a1, 0x40000000
  li a2, 4096
  call kmemcpy
  # Map child text frame
  mv a0, s2           # child_root_pa
  li a1, USER_TEXT_VA
  mv a2, s3
  li a3, 0xDF         # PTE_USER_TEXT (V | R | W | X | U | A | D)
  call vmm_map_page

  # Clone user stack page (USER_STACK_VA = 0x7FFFF000)
  call alloc_frame
  beqz a0, sys_fork_fail
  mv s4, a0           # s4 = child_stack_frame
  # Copy 4096 bytes from 0x7FFFF000 to child_stack_frame
  mv a0, s4
  li a1, USER_STACK_VA
  li a2, 4096
  call kmemcpy
  # Map child stack frame
  mv a0, s2           # child_root_pa
  li a1, USER_STACK_VA
  mv a2, s4
  li a3, PTE_USER_DATA # 0xD7
  call vmm_map_page

  # Duplicate parent's trapframe into child's trapframe
  lw a1, 28(s0)       # src = parent.tf
  lw a0, 28(s1)       # dst = child.tf
  li a2, 144
  call kmemcpy

  # Copy the parent's working directory to the child
  lw t1, 40(s0)       # parent.cwd
  sw t1, 40(s1)       # child.cwd

  # Copy the parent's open file descriptors to the child
  mv a0, s0
  mv a1, s1
  call ofile_copy

  # Child return value: child_tf.a0 = 0 (offset 40)
  lw t1, 28(s1)       # child.tf
  sw x0, 40(t1)

  # Mark child RUNNABLE (1)
  li t2, 1
  sw t2, 0(s1)

  # Parent returns child PID
  lw a0, 4(s1)        # child.pid
  j sys_fork_done

sys_fork_fail:
  li a0, -1

sys_fork_done:
  lw s4, 4(sp)
  lw s3, 8(sp)
  lw s2, 12(sp)
  lw s1, 16(sp)
  lw s0, 20(sp)
  lw ra, 24(sp)
  addi sp, sp, 28
  ret

# sys_waitpid(a0=pid, a1=status_ptr): Waits for child process termination.
# Returns reaped child PID, or -1.
.global sys_waitpid
sys_waitpid:
  addi sp, sp, -20
  sw ra, 16(sp)
  sw s0, 12(sp)
  sw s1, 8(sp)
  sw s2, 4(sp)
  mv s0, a0           # target pid (-1 for any child)
  mv s1, a1           # status_ptr

sys_wait_loop:
  la t0, current_proc
  lw s2, 0(t0)        # s2 = current PCB
  beqz s2, sys_wait_err
  lw t1, 4(s2)        # my pid

  # Scan proc_table for matching children
  la t0, proc_table
  li t2, 0            # index
  li t3, 16           # MAX_PROCS
  li t4, 0            # children found flag
sys_wait_scan:
  lw t5, 0(t0)        # pcb.state
  beqz t5, sys_wait_next
  lw t6, 8(t0)        # pcb.parent_pid (PCB_PPID = 8)
  bne t6, t1, sys_wait_next # not my child

  # If specific pid requested, check match
  li a2, -1
  beq s0, a2, sys_wait_match
  lw a3, 4(t0)        # pcb.pid
  bne a3, s0, sys_wait_next

sys_wait_match:
  li t4, 1            # found at least one matching child
  # Check if child is ZOMBIE (4)
  li a2, 4
  beq t5, a2, sys_wait_reap

sys_wait_next:
  addi t0, t0, 44     # PCB_SIZE
  addi t2, t2, 1
  blt t2, t3, sys_wait_scan

  # If no children at all -> ECHILD (-1)
  beqz t4, sys_wait_err

  # Children are still running -> rewind tf.epc by 4 and schedule away
  lw t0, 28(s2)       # current_proc.tf
  lw t1, 128(t0)      # tf.epc
  addi t1, t1, -4     # rewind to ecall
  sw t1, 128(t0)

  li t3, 1            # PROC_RUNNABLE
  sw t3, 0(s2)
  call schedule
  # Execution will resume via trap_return directly to ecall

sys_wait_reap:
  # Child at t0 is ZOMBIE! Reap it.
  lw a0, 4(t0)        # reaped pid
  lw a2, 32(t0)       # exitcode
  beqz s1, sys_wait_reap_free
  sw a2, 0(s1)        # store status to *status_ptr
sys_wait_reap_free:
  sw x0, 0(t0)        # free child PCB (state = 0)
  j sys_wait_done

sys_wait_err:
  li a0, -1

sys_wait_done:
  lw s2, 4(sp)
  lw s1, 8(sp)
  lw s0, 12(sp)
  lw ra, 16(sp)
  addi sp, sp, 20
  ret

# kmemcpy(a0=dst, a1=src, a2=count): Copies memory bytes in kernel mode.
.global kmemcpy
kmemcpy:
  li t0, 0
kmemcpy_loop:
  bge t0, a2, kmemcpy_done
  add t1, a1, t0
  lbu t2, 0(t1)
  add t3, a0, t0
  sb t2, 0(t3)
  addi t0, t0, 1
  j kmemcpy_loop
kmemcpy_done:
  ret

