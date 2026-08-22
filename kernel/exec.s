# exec.s - ELF32 Executable Loader & sys_exec for BrowOS kernel.
# Loads PT_LOAD segments from BrFS files into Sv32 user address spaces.

.section .text
.align 2
.global elf_load
.global sys_exec

# elf_load(a0=inode_no, a1=pcb_ptr): Loads ELF32 binary into PCB's address space.
# Returns a0 = 0 on success, -1 on invalid ELF, -2 on out-of-memory.
elf_load:
  addi sp, sp, -48
  sw ra, 44(sp)
  sw s0, 40(sp)
  sw s1, 36(sp)
  sw s2, 32(sp)
  sw s3, 28(sp)
  sw s4, 24(sp)
  sw s5, 20(sp)
  sw s6, 16(sp)
  sw s7, 12(sp)
  sw s8, 8(sp)
  sw s9, 4(sp)

  mv s0, a0        # s0 = inode_no
  mv s1, a1        # s1 = pcb_ptr

  # Read ELF header (52 bytes) into elf_hdr_scratch
  mv a0, s0
  li a1, 0         # offset 0
  la a2, elf_hdr_scratch
  li a3, 52
  call fs_read
  li t0, 52
  bne a0, t0, elf_load_bad_hdr

  # Verify ELF magic (\x7fELF = 0x464C457F)
  la t0, elf_hdr_scratch
  lw t1, 0(t0)
  li t2, 0x464C457F
  bne t1, t2, elf_load_bad_hdr

  # Verify 32-bit (e_ident[4] == 1) and little-endian (e_ident[5] == 1)
  lbu t1, 4(t0)
  li t2, 1
  bne t1, t2, elf_load_bad_hdr
  lbu t1, 5(t0)
  bne t1, t2, elf_load_bad_hdr

  # Extract e_entry (offset 24), e_phoff (offset 28), e_phnum (offset 44)
  lw s2, 24(t0)    # s2 = e_entry
  lw s3, 28(t0)    # s3 = e_phoff
  lhu s4, 44(t0)   # s4 = e_phnum

  # Get process root table PA from pcb.satp
  lw s5, 16(s1)    # s5 = root_pa

  # Iterate through program headers
  li s6, 0         # s6 = ph index
elf_load_ph_loop:
  bge s6, s4, elf_load_stack_setup

  # Read 32-byte program header: offset = e_phoff + s6 * 32
  slli t0, s6, 5
  add a1, s3, t0
  mv a0, s0
  la a2, elf_ph_scratch
  li a3, 32
  call fs_read
  li t0, 32
  bne a0, t0, elf_load_bad_hdr

  # Check p_type == 1 (PT_LOAD)
  la t0, elf_ph_scratch
  lw t1, 0(t0)
  li t2, 1         # PT_LOAD
  bne t1, t2, elf_load_ph_next

  # Extract p_offset (4), p_vaddr (8), p_filesz (16), p_memsz (20), p_flags (24)
  lw s7, 4(t0)     # s7 = p_offset
  lw t1, 8(t0)     # t1 = p_vaddr
  lw t2, 16(t0)    # t2 = p_filesz
  lw t3, 20(t0)    # t3 = p_memsz
  lw t4, 24(t0)    # t4 = p_flags

  # Convert p_flags (PF_X=1, PF_W=2, PF_R=4) to Sv32 PTE flags
  # Base: PTE_V(1) | PTE_U(0x10) | PTE_A(0x40) | PTE_D(0x80) = 0xD1
  li a3, 0xD1
  andi t5, t4, 1   # PF_X
  beqz t5, elf_nofl_x
  ori a3, a3, 0x08 # PTE_X
elf_nofl_x:
  andi t5, t4, 2   # PF_W
  beqz t5, elf_nofl_w
  ori a3, a3, 0x04 # PTE_W
elf_nofl_w:
  andi t5, t4, 4   # PF_R
  beqz t5, elf_nofl_r
  ori a3, a3, 0x02 # PTE_R
elf_nofl_r:

  # Save flags, starting VA, ending VA, file offset, and filesz
  la t0, elf_seg_flags
  sw a3, 0(t0)
  la t0, elf_seg_curr_va
  sw t1, 0(t0)
  add t5, t1, t3   # end_va = p_vaddr + p_memsz
  la t0, elf_seg_end_va
  sw t5, 0(t0)
  la t0, elf_seg_file_off
  sw s7, 0(t0)
  la t0, elf_seg_rem_filesz
  sw t2, 0(t0)

elf_page_loop:
  la t0, elf_seg_curr_va
  lw t1, 0(t0)
  la t0, elf_seg_end_va
  lw t2, 0(t0)
  bge t1, t2, elf_load_ph_next

  # Allocate physical frame for this 4 KiB page
  call alloc_frame
  beqz a0, elf_load_oom
  mv s8, a0        # s8 = frame_pa

  # Zero the frame
  mv a0, s8
  call zero_frame

  # Check how many bytes to read from file for this page (min(rem_filesz, 4096))
  la t0, elf_seg_rem_filesz
  lw s9, 0(t0)     # s9 = rem_filesz
  li t3, 4096
  blt s9, t3, elf_read_sz_ok
  li s9, 4096
elf_read_sz_ok:
  beqz s9, elf_page_skip_read

  # Read s9 bytes from file into frame_pa
  la t0, elf_seg_file_off
  lw a1, 0(t0)     # offset
  mv a0, s0        # inode_no
  mv a2, s8        # dst = frame_pa
  mv a3, s9        # count = s9
  call fs_read

  # Advance file offset and reduce rem_filesz by s9
  la t0, elf_seg_file_off
  lw t1, 0(t0)
  add t1, t1, s9
  sw t1, 0(t0)

  la t0, elf_seg_rem_filesz
  lw t1, 0(t0)
  sub t1, t1, s9
  sw t1, 0(t0)

elf_page_skip_read:
  # Map virtual page at elf_seg_curr_va
  mv a0, s5        # root_pa
  la t0, elf_seg_curr_va
  lw a1, 0(t0)     # va
  mv a2, s8        # pa
  la t0, elf_seg_flags
  lw a3, 0(t0)     # flags
  call vmm_map_page

  # Advance curr_va by 4096
  la t0, elf_seg_curr_va
  lw t1, 0(t0)
  li t2, 4096
  add t1, t1, t2
  sw t1, 0(t0)

  j elf_page_loop

elf_load_ph_next:
  addi s6, s6, 1
  j elf_load_ph_loop

elf_load_stack_setup:
  # Allocate user stack page
  call alloc_frame
  beqz a0, elf_load_oom
  mv s8, a0

  # Zero stack page
  mv a0, s8
  call zero_frame

  # Map user stack at USER_STACK_VA (0x7FFF0000)
  mv a0, s5        # root_pa
  li a1, USER_STACK_VA
  mv a2, s8        # pa
  li a3, PTE_USER_DATA # 0xD7 (V | R | W | U | A | D)
  call vmm_map_page

  # Configure trapframe
  lw t0, 28(s1)    # pcb.tf
  # Set tf.epc = e_entry
  sw s2, 128(t0)
  # Set tf.sp = USER_STACK_TOP (0x7FFFF000)
  li t1, USER_STACK_TOP
  sw t1, 8(t0)
  # Set tf.sstatus = MSTATUS_SPIE (0x20) | SUM (0x40000) = 0x40020 (U-mode on sret, SUM=1)
  li t1, 0x40020
  sw t1, 132(t0)

  li a0, 0
  j elf_load_done

elf_load_bad_hdr:
  li a0, -1
  j elf_load_done

elf_load_oom:
  li a0, -2

elf_load_done:
  lw s9, 4(sp)
  lw s8, 8(sp)
  lw s7, 12(sp)
  lw s6, 16(sp)
  lw s5, 20(sp)
  lw s4, 24(sp)
  lw s3, 28(sp)
  lw s2, 32(sp)
  lw s1, 36(sp)
  lw s0, 40(sp)
  lw ra, 44(sp)
  addi sp, sp, 48
  ret

# sys_exec(a0=path_ptr, a1=argv_ptr): Replaces current process with new ELF binary.
sys_exec:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)
  mv s0, a0        # path_ptr
  mv s1, a1        # argv_ptr

  # Get current process PCB
  la t0, current_proc
  lw t1, 0(t0)
  beqz t1, sys_exec_notfound

  # Resolve the executable path relative to the current working directory
  lw a0, 40(t1)    # pcb.cwd
  mv a1, s0
  call fs_resolve
  li t0, -1
  beq a0, t0, sys_exec_notfound
  mv s0, a0        # s0 = inode_no

  # Get current process PCB
  la t0, current_proc
  lw s1, 0(t0)
  beqz s1, sys_exec_err

  # Load ELF into current process
  mv a0, s0
  mv a1, s1
  call elf_load
  bnez a0, sys_exec_err

  # A successful exec discards the process's open file descriptors
  mv a0, s1
  call ofile_clear

  # Return 0 (execution resumes at new entrypoint via trap_return)
  li a0, 0
  j sys_exec_done

sys_exec_notfound:
sys_exec_err:
  li a0, -1

sys_exec_done:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

.section .bss
.align 4
elf_hdr_scratch:    .zero 64
elf_ph_scratch:     .zero 32
elf_seg_flags:      .zero 4
elf_seg_curr_va:    .zero 4
elf_seg_end_va:     .zero 4
elf_seg_file_off:   .zero 4
elf_seg_rem_filesz: .zero 4
