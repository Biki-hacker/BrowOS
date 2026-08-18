# proc.s - Process Control Block (PCB) and Process Table Management.

.section .data
.align 4
.global proc_table
.global current_proc
.global next_pid

proc_table:   .zero 640  # 16 PCBs * 40 bytes
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
  li t2, 160  # 640 bytes / 4 = 160 words
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
  addi s0, s0, 40  # PCB_SIZE
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

  # Map user stack at VA 0x7FFF0000 (User Data: R | W | U)
  mv a0, s3
  li a1, 0x7FFF0000
  mv a2, s4
  li a3, 0x17    # PTE_V | PTE_R | PTE_W | PTE_U
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

  # Map user code page at VA 0x40000000 (User Text: R | X | U)
  mv a0, s3
  li a1, 0x40000000
  mv a2, s4
  li a3, 0x1B    # PTE_V | PTE_R | PTE_X | PTE_U
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
  # Set tf.sp = 0x7FFFF000 (offset 8)
  li t1, 0x7FFFF000
  sw t1, 8(t0)
  # Set tf.sstatus = MSTATUS_SPIE (0x20) (offset 132, U-mode with interrupts enabled on sret)
  li t1, 0x20
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
