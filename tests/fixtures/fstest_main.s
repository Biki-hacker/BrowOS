# fstest_main.s - BrFS filesystem test driver (replaces main.s).
# Boots the kernel subsystems, then runs filesystem tests in M-mode.
# Reports via tohost: 1 = pass, (testnum << 1) | 1 = fail.

.text
.globl _start
_start:
  la sp, stack_top
  call fstest_kmain
fstest_spin:
  j fstest_spin

# Fallback return target used by schedule() when the saved return address
# is null; never reached in the fs test driver (which never schedules).
.global kmain_sched_returned
kmain_sched_returned:
  j fstest_spin

# fstest_kmain: frame ra@40 s0@36 s1@32 s2@28 s3@24 s4@20 s5@16 s6@12 s7@8
.globl fstest_kmain
fstest_kmain:
  addi sp, sp, -44
  sw ra, 40(sp)
  sw s0, 36(sp)
  sw s1, 32(sp)
  sw s2, 28(sp)
  sw s3, 24(sp)
  sw s4, 20(sp)
  sw s5, 16(sp)
  sw s6, 12(sp)
  sw s7, 8(sp)

  # Boot the subsystems the FS layer needs
  call pmm_init
  la t0, heap_next
  li t1, HEAP_START
  sw t1, 0(t0)
  la t0, heap_free
  sw x0, 0(t0)
  call vmm_init
  call pipe_init
  call uart_init
  call blk_init
  beqz a0, fstest_fail

  # TEST 1: fs_init formats the disk with correct accounting
  li s0, 1
  call fs_init
  bnez a0, fstest_fail
  la t0, fs_total_blocks
  lw t1, 0(t0)
  li t2, 256                # 2048 sectors / 8
  bne t1, t2, fstest_fail
  la t0, fs_free_blocks
  lw t1, 0(t0)
  li t2, 249                # 256 - 6 reserved - 1 root dir block
  bne t1, t2, fstest_fail

  # TEST 2: root directory contains "." and ".." and is empty
  li s0, 2
  li a0, 0
  la a1, str_dot
  call fs_lookup
  bnez a0, fstest_fail
  li a0, 0
  la a1, str_dotdot
  call fs_lookup
  bnez a0, fstest_fail
  li a0, 0
  call fs_dir_empty
  li t0, 1
  bne a0, t0, fstest_fail
  li a0, 0
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 4(t0)              # size
  li t2, 64
  bne t1, t2, fstest_fail

  # TEST 3: mkdir tree and path resolution
  li s0, 3
  li a0, 0
  la a1, str_a
  call fs_mkdir
  li t0, -1
  beq a0, t0, fstest_fail
  mv s1, a0                 # s1 = /a inode
  mv a0, s1
  la a1, str_b
  call fs_mkdir
  li t0, -1
  beq a0, t0, fstest_fail
  mv s2, a0                 # s2 = /a/b inode

  # Absolute path
  li a0, 0
  la a1, str_ab
  call fs_resolve
  bne a0, s2, fstest_fail
  # Relative path
  li a0, 0
  la a1, str_a_slash_b
  call fs_resolve
  bne a0, s2, fstest_fail
  # "." and "/" resolve to root
  li a0, 0
  la a1, str_dot
  call fs_resolve
  bnez a0, fstest_fail
  li a0, 0
  la a1, str_slash
  call fs_resolve
  bnez a0, fstest_fail
  # ".." from root stays at root
  li a0, 0
  la a1, str_dotdot
  call fs_resolve
  bnez a0, fstest_fail
  # ".." walks up
  mv a0, s2
  la a1, str_dotdot
  call fs_resolve
  bne a0, s1, fstest_fail
  mv a0, s1
  la a1, str_dotdot
  call fs_resolve
  bnez a0, fstest_fail
  # Embedded "." and "//" components
  li a0, 0
  la a1, str_a_dot_slash_b
  call fs_resolve
  bne a0, s2, fstest_fail
  li a0, 0
  la a1, str_a_2slash_b
  call fs_resolve
  bne a0, s2, fstest_fail
  # Trailing slash
  li a0, 0
  la a1, str_a_slash_b_slash
  call fs_resolve
  bne a0, s2, fstest_fail
  # Missing paths
  li a0, 0
  la a1, str_zz
  call fs_resolve
  li t0, -1
  bne a0, t0, fstest_fail
  li a0, 0
  la a1, str_a_slash_zz
  call fs_resolve
  li t0, -1
  bne a0, t0, fstest_fail
  # Empty path
  li a0, 0
  la a1, str_empty
  call fs_resolve
  li t0, -1
  bne a0, t0, fstest_fail

  # TEST 4: multi-block file write/read via direct + indirect blocks
  li s0, 4
  li a0, 0
  la a1, str_big
  li a2, BRFS_INODE_FILE
  call fs_create
  li t0, -1
  beq a0, t0, fstest_fail
  mv s3, a0                 # s3 = /big inode

  # Fill 9000 bytes of pattern (i % 251) + 1
  la s4, fs_test_buf
  li s5, 0                  # i
fstest_fill9000:
  li t0, 9000
  bge s5, t0, fstest_fill9000_done
  li t0, 251
  remu t1, s5, t0
  addi t1, t1, 1
  add t2, s4, s5
  sb t1, 0(t2)
  addi s5, s5, 1
  j fstest_fill9000
fstest_fill9000_done:

  mv a0, s3
  li a1, 0
  mv a2, s4
  li a3, 9000
  call fs_write
  li t0, 9000
  bne a0, t0, fstest_fail

  # Write 200 bytes at offset 49152 (block 12 -> indirect)
  mv a0, s3
  li a1, 49152
  mv a2, s4
  li a3, 200
  call fs_write
  li t0, 200
  bne a0, t0, fstest_fail

  # Verify inode: size 49352, indirect set, direct[11] untouched
  mv a0, s3
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 4(t0)
  li t2, 49352
  bne t1, t2, fstest_fail
  lw t1, 60(t0)             # indirect
  beqz t1, fstest_fail
  lw t1, 56(t0)             # direct[11]
  bnez t1, fstest_fail

  # Read back and compare: blocks 0, 1, 2
  mv a0, s3
  li a1, 0
  la a2, fs_test_buf2
  li a3, 4096
  call fs_read
  li t0, 4096
  bne a0, t0, fstest_fail
  la a0, fs_test_buf
  la a1, fs_test_buf2
  li a2, 4096
  call fstest_memcmp
  bnez a0, fstest_fail

  mv a0, s3
  li a1, 4096
  la a2, fs_test_buf2
  li a3, 4096
  call fs_read
  li t0, 4096
  bne a0, t0, fstest_fail
  li t0, 4096
  add a0, s4, t0
  la a1, fs_test_buf2
  li a2, 4096
  call fstest_memcmp
  bnez a0, fstest_fail

  mv a0, s3
  li a1, 8192
  la a2, fs_test_buf2
  li a3, 808
  call fs_read
  li t0, 808
  bne a0, t0, fstest_fail
  li t0, 8192
  add a0, s4, t0
  la a1, fs_test_buf2
  li a2, 808
  call fstest_memcmp
  bnez a0, fstest_fail

  # Reading a hole (unallocated block 11) returns 0 bytes
  mv a0, s3
  li a1, 45056
  la a2, fs_test_buf2
  li a3, 4096
  call fs_read
  bnez a0, fstest_fail

  # Read the 200 bytes at offset 49152
  mv a0, s3
  li a1, 49152
  la a2, fs_test_buf2
  li a3, 200
  call fs_read
  li t0, 200
  bne a0, t0, fstest_fail
  mv a0, s4
  la a1, fs_test_buf2
  li a2, 200
  call fstest_memcmp
  bnez a0, fstest_fail

  # TEST 5: truncate frees all blocks and zeroes size
  li s0, 5
  la t0, fs_free_blocks
  lw s5, 0(t0)              # s5 = free before
  mv a0, s3
  call fs_truncate
  bnez a0, fstest_fail
  mv a0, s3
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 4(t0)              # size
  bnez t1, fstest_fail
  lw t1, 12(t0)             # direct[0]
  bnez t1, fstest_fail
  lw t1, 60(t0)             # indirect
  bnez t1, fstest_fail
  # 5 blocks freed: direct 0..2, indirect block, data block 12
  la t0, fs_free_blocks
  lw t1, 0(t0)
  addi t2, s5, 5
  bne t1, t2, fstest_fail
  # Reading a truncated file returns 0 bytes
  mv a0, s3
  li a1, 0
  la a2, fs_test_buf2
  li a3, 1
  call fs_read
  bnez a0, fstest_fail

  # TEST 6: multi-block directory growth via fs_dir_add
  li s0, 6
  li a0, 0
  la a1, str_many
  call fs_mkdir
  li t0, -1
  beq a0, t0, fstest_fail
  mv s4, a0                 # s4 = /many inode

  # Add 130 entries "f000".."f129" (all pointing at inode 1 = /a)
  li s5, 0                  # i
fstest_dadd:
  li t0, 130
  bge s5, t0, fstest_dadd_done
  la a0, fs_name_buf
  li a1, 'f'
  mv a2, s5
  call fstest_fmt3
  mv a0, s4
  la a1, fs_name_buf
  li a2, 1                  # inode 1 (/a)
  call fs_dir_add
  bnez a0, fstest_fail
  addi s5, s5, 1
  j fstest_dadd
fstest_dadd_done:

  # Dir size must be 64 + 130*32 = 4224 (two blocks)
  mv a0, s4
  call fs_read_inode
  la t0, fs_inode_buf
  lw t1, 4(t0)
  li t2, 4224
  bne t1, t2, fstest_fail
  lw t1, 12(t0)             # direct[0]
  beqz t1, fstest_fail
  lw t1, 16(t0)             # direct[1] (second block)
  beqz t1, fstest_fail

  # Lookup first and last entries across blocks
  mv a0, s4
  la a1, str_f000
  call fs_lookup
  li t0, 1
  bne a0, t0, fstest_fail
  mv a0, s4
  la a1, str_f129
  call fs_lookup
  li t0, 1
  bne a0, t0, fstest_fail

  # Resolve through the multi-block dir
  li a0, 0
  la a1, str_many_slash_f129
  call fs_resolve
  li t0, 1
  bne a0, t0, fstest_fail

  # Not empty
  mv a0, s4
  call fs_dir_empty
  bnez a0, fstest_fail

  # TEST 7: cross-block unlink of real files inside a multi-block dir
  li s0, 7
  # Create 20 real files r000..r019 (entries land in block 1)
  li s5, 0
fstest_rcreate:
  li t0, 20
  bge s5, t0, fstest_rcreate_done
  la a0, fs_name_buf
  li a1, 'r'
  mv a2, s5
  call fstest_fmt3
  mv a0, s4
  la a1, fs_name_buf
  li a2, BRFS_INODE_FILE
  call fs_create
  li t0, -1
  beq a0, t0, fstest_fail
  addi s5, s5, 1
  j fstest_rcreate
fstest_rcreate_done:

  # Unlink r005 (entry at block 1); last entry r019 moves into its slot
  mv a0, s4
  la a1, str_r005
  call fs_unlink
  bnez a0, fstest_fail
  mv a0, s4
  la a1, str_r005
  call fs_lookup
  li t0, -1
  bne a0, t0, fstest_fail
  mv a0, s4
  la a1, str_r019
  call fs_lookup
  li t0, -1
  beq a0, t0, fstest_fail

  # Unlink the remaining 19 files (all in block 1)
  li s5, 0
fstest_rdelete:
  li t0, 20
  bge s5, t0, fstest_rdelete_done
  li t0, 5
  beq s5, t0, fstest_rdelete_next
  la a0, fs_name_buf
  li a1, 'r'
  mv a2, s5
  call fstest_fmt3
  mv a0, s4
  la a1, fs_name_buf
  call fs_unlink
  bnez a0, fstest_fail
fstest_rdelete_next:
  addi s5, s5, 1
  j fstest_rdelete
fstest_rdelete_done:

  # TEST 8: fs_dir_name_of finds a child's name in a directory
  li s0, 8
  mv a0, s1                  # /a
  mv a1, s2                  # /a/b
  la a2, fs_leaf_buf
  call fs_dir_name_of
  bnez a0, fstest_fail
  la t0, fs_leaf_buf
  lbu t1, 0(t0)
  li t2, 'b'
  bne t1, t2, fstest_fail
  lbu t1, 1(t0)
  bnez t1, fstest_fail
  # Name of /a in root
  li a0, 0
  mv a1, s1
  la a2, fs_leaf_buf
  call fs_dir_name_of
  bnez a0, fstest_fail
  la t0, fs_leaf_buf
  lbu t1, 0(t0)
  li t2, 'a'
  bne t1, t2, fstest_fail
  # /a/b is not in root
  li a0, 0
  mv a1, s2
  la a2, fs_leaf_buf
  call fs_dir_name_of
  li t0, -1
  bne a0, t0, fstest_fail

  # TEST 9: fs_resolve_parent splits paths correctly
  li s0, 9
  # "a/b" -> parent /a, leaf "b"
  la a0, fs_path_in
  la a1, str_a_slash_b
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  bne a0, s1, fstest_fail
  la t0, fs_path_scratch
  lbu t1, 0(t0)
  li t2, 'b'
  bne t1, t2, fstest_fail
  # "a" -> parent root, leaf "a"
  la a0, fs_path_in
  la a1, str_a
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  bnez a0, fstest_fail
  la t0, fs_path_scratch
  lbu t1, 0(t0)
  li t2, 'a'
  bne t1, t2, fstest_fail
  # "/a/b" -> parent /a, leaf "b"
  la a0, fs_path_in
  la a1, str_ab
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  bne a0, s1, fstest_fail
  # "a/" -> trailing slash trimmed, parent root, leaf "a"
  la a0, fs_path_in
  la a1, str_a_slash
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  bnez a0, fstest_fail
  la t0, fs_path_scratch
  lbu t1, 0(t0)
  li t2, 'a'
  bne t1, t2, fstest_fail
  # "/" -> error
  la a0, fs_path_in
  la a1, str_slash
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  li t0, -1
  bne a0, t0, fstest_fail
  # "" -> error
  la a0, fs_path_in
  la a1, str_empty
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  li t0, -1
  bne a0, t0, fstest_fail
  # "." -> error
  la a0, fs_path_in
  la a1, str_dot
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  li t0, -1
  bne a0, t0, fstest_fail
  # ".." -> error
  la a0, fs_path_in
  la a1, str_dotdot
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  li t0, -1
  bne a0, t0, fstest_fail
  # 28-char leaf -> error
  la a0, fs_path_in
  la a1, str_long
  call fstest_strcpy
  li a0, 0
  la a1, fs_path_in
  call fs_resolve_parent
  li t0, -1
  bne a0, t0, fstest_fail

  # TEST 10: unlink guards and empty-directory removal
  li s0, 10
  # "." and ".." cannot be unlinked
  li a0, 0
  la a1, str_dot
  call fs_unlink
  li t0, -1
  bne a0, t0, fstest_fail
  li a0, 0
  la a1, str_dotdot
  call fs_unlink
  li t0, -1
  bne a0, t0, fstest_fail
  # Nonexistent file
  li a0, 0
  la a1, str_zz
  call fs_unlink
  li t0, -1
  bne a0, t0, fstest_fail
  # Non-empty directory cannot be removed
  li a0, 0
  la a1, str_many
  call fs_unlink
  li t0, -1
  bne a0, t0, fstest_fail
  li a0, 0
  la a1, str_a
  call fs_unlink
  li t0, -1
  bne a0, t0, fstest_fail
  # Empty directory can be removed
  mv a0, s1
  la a1, str_b
  call fs_unlink
  bnez a0, fstest_fail
  mv a0, s1
  la a1, str_b
  call fs_lookup
  li t0, -1
  bne a0, t0, fstest_fail
  mv a0, s1
  call fs_dir_empty
  li t0, 1
  bne a0, t0, fstest_fail
  li a0, 0
  la a1, str_a
  call fs_unlink
  bnez a0, fstest_fail
  li a0, 0
  la a1, str_a
  call fs_lookup
  li t0, -1
  bne a0, t0, fstest_fail
  # Resolving /a now fails
  li a0, 0
  la a1, str_a_slash_b
  call fs_resolve
  li t0, -1
  bne a0, t0, fstest_fail

  # TEST 11: overlong names are rejected without leaking resources
  li s0, 11
  la t0, fs_free_blocks
  lw s5, 0(t0)
  li a0, 0
  la a1, str_long
  li a2, BRFS_INODE_FILE
  call fs_create
  li t0, -1
  bne a0, t0, fstest_fail
  li a0, 0
  la a1, str_long
  li a2, 1
  call fs_dir_add
  li t0, -1
  bne a0, t0, fstest_fail
  # Nothing allocated, nothing leaked
  la t0, fs_free_blocks
  lw t1, 0(t0)
  bne t1, s5, fstest_fail
  # Final accounting: 249 - 1(a) - 1(b) - 5(big) + 5(trunc) - 1(many) - 1(second block)
  #   - 0(r files) + 2(freed a and b blocks) = 247
  li t2, 247
  bne t1, t2, fstest_fail

  li t0, 1
  j fstest_report

fstest_fail:
  slli t0, s0, 1
  ori t0, t0, 1
fstest_report:
  la t1, tohost
  sw t0, 0(t1)
  lw ra, 40(sp)
  lw s0, 36(sp)
  lw s1, 32(sp)
  lw s2, 28(sp)
  lw s3, 24(sp)
  lw s4, 20(sp)
  lw s5, 16(sp)
  lw s6, 12(sp)
  lw s7, 8(sp)
  addi sp, sp, 44
  ret

# ─── Helpers ───────────────────────────────────────────────────────────

# fstest_strcpy(a0=dst, a1=src): copies a NUL-terminated string.
fstest_strcpy:
  mv t0, a0
  mv t1, a1
fstest_strcpy_loop:
  lbu t2, 0(t1)
  sb t2, 0(t0)
  beqz t2, fstest_strcpy_done
  addi t0, t0, 1
  addi t1, t1, 1
  j fstest_strcpy_loop
fstest_strcpy_done:
  ret

# fstest_memcmp(a0=a, a1=b, a2=n): returns 0 if equal.
fstest_memcmp:
  li t0, 0
fstest_memcmp_loop:
  bge t0, a2, fstest_memcmp_eq
  add t1, a0, t0
  add t2, a1, t0
  lbu t3, 0(t1)
  lbu t4, 0(t2)
  bne t3, t4, fstest_memcmp_diff
  addi t0, t0, 1
  j fstest_memcmp_loop
fstest_memcmp_diff:
  li a0, 1
  ret
fstest_memcmp_eq:
  li a0, 0
  ret

# fstest_fmt3(a0=buf, a1=prefix_char, a2=num): writes "<prefix>%03d\0" (4 chars + NUL).
fstest_fmt3:
  sb a1, 0(a0)
  li t0, 100
  divu t1, a2, t0
  addi t1, t1, '0'
  sb t1, 1(a0)
  remu t1, a2, t0
  li t0, 10
  divu t2, t1, t0
  addi t2, t2, '0'
  sb t2, 2(a0)
  remu t1, t1, t0
  addi t1, t1, '0'
  sb t1, 3(a0)
  sb x0, 4(a0)
  ret

.data
tohost: .word 0
fromhost: .word 0
.global kmain_saved_sp
kmain_saved_sp: .word 0
.global kmain_saved_ra
kmain_saved_ra: .word 0

str_a:            .asciz "a"
str_b:            .asciz "b"
str_big:          .asciz "big"
str_many:         .asciz "many"
str_dot:          .asciz "."
str_dotdot:       .asciz ".."
str_slash:        .asciz "/"
str_empty:        .asciz ""
str_zz:           .asciz "zz"
str_ab:           .asciz "/a/b"
str_a_slash_b:    .asciz "a/b"
str_a_slash_b_slash: .asciz "a/b/"
str_a_slash:      .asciz "a/"
str_a_dot_slash_b: .asciz "a/./b"
str_a_2slash_b:   .asciz "a//b"
str_a_slash_zz:   .asciz "a/zz"
str_many_slash_f129: .asciz "many/f129"
str_f000:         .asciz "f000"
str_f129:         .asciz "f129"
str_r005:         .asciz "r005"
str_r019:         .asciz "r019"
str_long:         .asciz "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"

.bss
.align 12
stack: .zero 8192
stack_top:
.align 4
fs_test_buf:  .zero 16384
fs_test_buf2: .zero 16384
fs_path_in:   .zero 256
fs_name_buf:  .zero 32
fs_leaf_buf:  .zero 32
