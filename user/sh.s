# sh.s - Interactive Command Shell for BrowOS.
# Runs in U-mode as the primary userland shell process.

.section .text
.align 2
.global _start
.global sh_main

_start:
sh_main:
  # Print welcome banner
  la a0, str_banner
  call puts

sh_loop:
  # Print prompt: "browos:<cwd>$ "
  la a0, str_prompt_pre
  call print
  la a0, sh_cwd_buf
  li a1, 128
  call getcwd
  bltz a0, sh_prompt_fallback
  la a0, sh_cwd_buf
  call print
  j sh_prompt_suffix
sh_prompt_fallback:
  la a0, str_slash
  call print
sh_prompt_suffix:
  la a0, str_prompt_suf
  call print

  # Read command line
  la a0, line_buf
  li a1, 256
  call readline
  beqz a0, sh_loop  # empty line

  # Skip leading spaces
  la s0, line_buf
sh_skip_sp:
  lbu t0, 0(s0)
  li t1, ' '
  bne t0, t1, sh_eval
  addi s0, s0, 1
  j sh_skip_sp

sh_eval:
  lbu t0, 0(s0)
  beqz t0, sh_loop

  # ─── Built-in: help ──────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_help
  call strcmp
  bnez a0, sh_try_ls
  la a0, str_help_text
  call puts
  j sh_loop

sh_try_ls:
  # ─── Built-in: ls ────────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_ls
  call strcmp
  bnez a0, sh_try_clear

  # Open the current directory "."
  la a0, str_dot
  li a1, 0         # read-only
  call open
  li t0, -1
  beq a0, t0, sh_ls_err
  mv s1, a0        # s1 = fd

  # Read directory entries in 4096-byte chunks until EOF
sh_ls_read:
  mv a0, s1
  la a1, cat_buf
  li a2, 4096
  call read
  mv s2, a0        # bytes read
  beqz s2, sh_ls_close
  bltz s2, sh_ls_close

  # Scan 32-byte entries in cat_buf
  li s3, 0         # offset
sh_ls_loop:
  bge s3, s2, sh_ls_read
  la t0, cat_buf
  add t0, t0, s3
  lw t1, 0(t0)     # inode_no
  li t2, -1
  beq t1, t2, sh_ls_next
  # Check if empty name
  addi t3, t0, 4   # name ptr
  lbu t4, 0(t3)
  beqz t4, sh_ls_next
  # Skip "." and ".."
  li t5, '.'
  bne t4, t5, sh_ls_print
  lbu t4, 1(t3)
  beqz t4, sh_ls_next
  li t5, '.'
  bne t4, t5, sh_ls_print
  lbu t4, 2(t3)
  beqz t4, sh_ls_next

sh_ls_print:
  mv a0, t3
  call print
  la a0, str_space_two
  call print

sh_ls_next:
  addi s3, s3, 32
  j sh_ls_loop

sh_ls_close:
  mv a0, s1
  call close

sh_ls_done:
  la a0, str_newline
  call print
  j sh_loop

sh_ls_err:
  la a0, str_ls_err
  call puts
  j sh_loop

sh_try_clear:
  # ─── Built-in: clear ─────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_clear
  call strcmp
  bnez a0, sh_try_uname
  la a0, str_clear_seq
  call print
  j sh_loop

sh_try_uname:
  # ─── Built-in: uname ─────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_uname
  call strcmp
  bnez a0, sh_try_cd
  la a0, str_uname_text
  call puts
  j sh_loop

sh_try_cd:
  # ─── Built-in: cd <dir> ─────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_cd
  li a2, 2
  call strncmp
  bnez a0, sh_try_pwd
  lbu t0, 2(s0)
  beqz t0, sh_cd_root
  li t1, ' '
  bne t0, t1, sh_try_pwd
  addi a0, s0, 2
sh_cd_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_cd_do
  addi a0, a0, 1
  j sh_cd_sp
sh_cd_do:
  # Bare "cd" (or trailing spaces) changes to the root directory
  beqz t0, sh_cd_root
  li t1, ' '
  bne t0, t1, sh_cd_call
  addi a0, a0, 1
  j sh_cd_do
sh_cd_call:
  call chdir
  bnez a0, sh_cd_err
  j sh_loop
sh_cd_root:
  la a0, str_slash
  call chdir
  bnez a0, sh_cd_err
  j sh_loop
sh_cd_err:
  la a0, str_cd_err
  call puts
  j sh_loop

sh_try_pwd:
  # ─── Built-in: pwd ───────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_pwd
  call strcmp
  bnez a0, sh_try_uptime
  la a0, sh_cwd_buf
  li a1, 128
  call getcwd
  bltz a0, sh_pwd_err
  la a0, sh_cwd_buf
  call puts
  j sh_loop
sh_pwd_err:
  la a0, str_cd_err
  call puts
  j sh_loop

sh_try_uptime:
  # ─── Built-in: uptime ────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_uptime
  call strcmp
  bnez a0, sh_try_ps
  la a0, str_uptime_msg
  call print
  rdcycle a0
  call print_num
  la a0, str_cycles_msg
  call puts
  j sh_loop

sh_try_ps:
  # ─── Built-in: ps ────────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_ps
  call strcmp
  bnez a0, sh_try_echo
  la a0, str_ps_header
  call puts
  call getpid
  mv s1, a0
  la a0, str_ps_entry
  call print
  mv a0, s1
  call print_num
  la a0, str_ps_running
  call puts
  j sh_loop

sh_try_echo:
  # ─── Built-in: echo <text> ───────────────────────────────────────────
  mv a0, s0
  la a1, cmd_echo
  li a2, 4
  call strncmp
  bnez a0, sh_try_cat
  lbu t0, 4(s0)
  beqz t0, sh_echo_empty
  li t1, ' '
  bne t0, t1, sh_try_cat
  addi a0, s0, 4
sh_echo_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_echo_print
  addi a0, a0, 1
  j sh_echo_sp
sh_echo_empty:
  la a0, str_newline
  call print
  j sh_loop
sh_echo_print:
  call puts
  j sh_loop

sh_try_cat:
  # ─── Built-in: cat <file> ────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_cat
  li a2, 3
  call strncmp
  bnez a0, sh_try_mkdir
  lbu t0, 3(s0)
  beqz t0, sh_cat_usage
  li t1, ' '
  bne t0, t1, sh_try_mkdir
  addi a0, s0, 3
sh_cat_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_cat_open
  addi a0, a0, 1
  j sh_cat_sp
sh_cat_open:
  beqz t0, sh_cat_usage
  li a1, 0         # read-only
  call open
  li t0, -1
  beq a0, t0, sh_cat_err
  mv s1, a0        # s1 = fd
  # Read file and display
  mv a0, s1
  la a1, cat_buf
  li a2, 4095
  call read
  la t0, cat_buf
  add t0, t0, a0
  sb x0, 0(t0)     # null-terminate
  la a0, cat_buf
  call print
  # Close fd
  mv a0, s1
  call close
  j sh_loop
sh_cat_usage:
  la a0, str_cat_usage
  call puts
  j sh_loop
sh_cat_err:
  la a0, str_cat_notfound
  call puts
  j sh_loop

sh_try_mkdir:
  # ─── Built-in: mkdir <dir> ───────────────────────────────────────────
  mv a0, s0
  la a1, cmd_mkdir
  li a2, 5
  call strncmp
  bnez a0, sh_try_rmdir
  lbu t0, 5(s0)
  beqz t0, sh_mkdir_usage
  li t1, ' '
  bne t0, t1, sh_try_rmdir
  addi a0, s0, 5
sh_mkdir_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_mkdir_do
  addi a0, a0, 1
  j sh_mkdir_sp
sh_mkdir_do:
  beqz t0, sh_mkdir_usage
  call mkdir
  bnez a0, sh_mkdir_err
  j sh_loop
sh_mkdir_usage:
  la a0, str_mkdir_usage
  call puts
  j sh_loop
sh_mkdir_err:
  la a0, str_mkdir_err
  call puts
  j sh_loop

sh_try_rmdir:
  # ─── Built-in: rmdir <dir> ──────────────────────────────────────────
  mv a0, s0
  la a1, cmd_rmdir
  li a2, 5
  call strncmp
  bnez a0, sh_try_rm
  lbu t0, 5(s0)
  beqz t0, sh_rmdir_usage
  li t1, ' '
  bne t0, t1, sh_try_rm
  addi a0, s0, 5
sh_rmdir_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_rmdir_do
  addi a0, a0, 1
  j sh_rmdir_sp
sh_rmdir_do:
  beqz t0, sh_rmdir_usage
  mv s1, a0
  la a1, stat_scratch
  call stat
  li t0, -1
  beq a0, t0, sh_rmdir_err
  la t0, stat_scratch
  lw t1, 0(t0)         # stat.type
  li t2, 2             # BRFS_INODE_DIR
  bne t1, t2, sh_rmdir_not_dir
  mv a0, s1
  call unlink
  bnez a0, sh_rmdir_err
  j sh_loop
sh_rmdir_usage:
  la a0, str_rmdir_usage
  call puts
  j sh_loop
sh_rmdir_not_dir:
  la a0, str_rmdir_not_dir
  call puts
  j sh_loop
sh_rmdir_err:
  la a0, str_rmdir_err
  call puts
  j sh_loop

sh_try_rm:
  # ─── Built-in: rm <file> ─────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_rm
  li a2, 2
  call strncmp
  bnez a0, sh_try_touch
  lbu t0, 2(s0)
  beqz t0, sh_rm_usage
  li t1, ' '
  bne t0, t1, sh_try_touch
  addi a0, s0, 2
sh_rm_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_rm_do
  addi a0, a0, 1
  j sh_rm_sp
sh_rm_do:
  beqz t0, sh_rm_usage
  call unlink
  bnez a0, sh_rm_err
  j sh_loop
sh_rm_usage:
  la a0, str_rm_usage
  call puts
  j sh_loop
sh_rm_err:
  la a0, str_rm_err
  call puts
  j sh_loop

sh_try_touch:
  # ─── Built-in: touch <file> ──────────────────────────────────────────
  mv a0, s0
  la a1, cmd_touch
  li a2, 5
  call strncmp
  bnez a0, sh_try_kill
  lbu t0, 5(s0)
  beqz t0, sh_touch_usage
  li t1, ' '
  bne t0, t1, sh_try_kill
  addi a0, s0, 5
sh_touch_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_touch_do
  addi a0, a0, 1
  j sh_touch_sp
sh_touch_do:
  beqz t0, sh_touch_usage
  li a1, 1         # create flag
  call open
  li t0, -1
  beq a0, t0, sh_touch_err
  call close
  j sh_loop
sh_touch_usage:
  la a0, str_touch_usage
  call puts
  j sh_loop
sh_touch_err:
  la a0, str_touch_err
  call puts
  j sh_loop

sh_try_kill:
  # ─── Built-in: kill <pid> ────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_kill
  li a2, 4
  call strncmp
  bnez a0, sh_try_globe
  lbu t0, 4(s0)
  beqz t0, sh_kill_usage
  li t1, ' '
  bne t0, t1, sh_try_globe
  addi a0, s0, 4
sh_kill_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_kill_parse
  addi a0, a0, 1
  j sh_kill_sp
sh_kill_parse:
  beqz t0, sh_kill_usage
  li t2, 0         # parsed pid
sh_kill_digit_loop:
  lbu t0, 0(a0)
  beqz t0, sh_kill_do
  li t1, '0'
  blt t0, t1, sh_kill_usage
  li t1, '9'
  bgt t0, t1, sh_kill_usage
  # t2 = t2 * 10 + (t0 - '0')
  li t3, 10
  mul t2, t2, t3
  addi t0, t0, -48
  add t2, t2, t0
  addi a0, a0, 1
  j sh_kill_digit_loop
sh_kill_do:
  mv a0, t2
  li a1, 9         # SIGKILL
  call kill
  bnez a0, sh_kill_err
  j sh_loop
sh_kill_usage:
  la a0, str_kill_usage
  call puts
  j sh_loop
sh_kill_err:
  la a0, str_kill_err
  call puts
  j sh_loop

sh_try_globe:
  # ─── Built-in: globe (3D BrowGPU Raytracer Demo Toggle) ──────────────
  mv a0, s0
  la a1, cmd_globe
  call strcmp
  bnez a0, sh_try_halt

  # Check if globe is already active
  la t0, globe_active
  lw t1, 0(t0)
  bnez t1, sh_globe_stop

  # Set globe_active = 1
  li t1, 1
  sw t1, 0(t0)

  la a0, str_globe_msg
  call puts

  # Dispatch raytraced 3D globe compute kernel (op 3, kernel_id=1, time=10)
  li a0, 3           # GPU_OP_DISPATCH_COMPUTE
  li a1, 1           # kernel_id = 1 (raytrace_globe)
  li a2, 10          # time parameter
  li a3, 0
  call gpu_dispatch
  bnez a0, sh_globe_err

  # Present the rendered framebuffer to the host canvas (op 4)
  li a0, 4           # GPU_OP_PRESENT
  call gpu_dispatch
  bnez a0, sh_globe_err

  la a0, str_globe_done
  call puts
  j sh_loop

sh_globe_stop:
  # Set globe_active = 0
  sw x0, 0(t0)

  # Clear GPU framebuffer (op 1: clear color 0x00000000)
  li a0, 1           # GPU_OP_CLEAR
  li a1, 0           # color = 0
  call gpu_dispatch
  bnez a0, sh_globe_err

  # Present cleared framebuffer (op 4)
  li a0, 4           # GPU_OP_PRESENT
  call gpu_dispatch
  bnez a0, sh_globe_err

  la a0, str_globe_stop
  call puts
  j sh_loop

sh_globe_err:
  la a0, str_globe_err
  call puts
  j sh_loop

sh_try_halt:
  # ─── Built-in: shutdown / reboot / exit ──────────────────────────────
  mv a0, s0
  la a1, cmd_shutdown
  call strcmp
  beqz a0, sh_do_halt
  mv a0, s0
  la a1, cmd_reboot
  call strcmp
  beqz a0, sh_do_halt
  mv a0, s0
  la a1, cmd_exit
  call strcmp
  beqz a0, sh_do_halt

  # ─── Try Executable via BrFS ─────────────────────────────────────────
  mv a0, s0
  li a1, 0
  call exec

  # Exec failed / unknown command
  la a0, str_unknown
  call print
  mv a0, s0
  call puts
  j sh_loop

sh_do_halt:
  la a0, str_halt_msg
  call puts
  call halt
sh_spin:
  j sh_spin

.section .data
str_banner:
  .asciz "Welcome to BrowOS 0.1.0 (RV32IM / Sv32)\nType 'help' for a list of available commands."
str_prompt_pre:  .asciz "browos:"
str_prompt_suf:  .asciz "$ "
str_slash:       .asciz "/"
str_dot:         .asciz "."
str_clear_seq:   .asciz "\x1b[2J\x1b[H"
str_uname_text:  .asciz "BrowOS 0.1.0 rv32im (Sv32 MMU)"
str_uptime_msg:  .asciz "up "
str_cycles_msg:  .asciz " cycles"
str_ps_header:   .asciz "  PID  TTY  STAT  COMMAND"
str_ps_entry:    .asciz "    "
str_ps_running:  .asciz "  tty1  R     sh"
str_cat_usage:   .asciz "cat: missing file argument"
str_cat_notfound:.asciz "cat: file not found"
str_mkdir_usage: .asciz "mkdir: missing directory argument"
str_mkdir_err:   .asciz "mkdir: failed to create directory"
str_rmdir_usage: .asciz "rmdir: missing directory argument"
str_rmdir_not_dir:.asciz "rmdir: not a directory"
str_rmdir_err:   .asciz "rmdir: failed to remove directory"
str_rm_usage:    .asciz "rm: missing file argument"
str_rm_err:      .asciz "rm: failed to remove file"
str_touch_usage: .asciz "touch: missing file argument"
str_touch_err:   .asciz "touch: failed to create file"
str_cd_err:      .asciz "cd: no such file or directory"
str_cd_not_dir:  .asciz "cd: not a directory"
str_ls_err:      .asciz "ls: failed to read directory"
str_space_two:   .asciz "  "
str_newline:     .asciz "\n"
str_kill_usage:  .asciz "kill: missing pid argument"
str_kill_err:    .asciz "kill: process not found"
str_globe_msg:   .asciz "BrowGPU: Computing 3D Raytraced Earth Globe..."
str_globe_done:  .asciz "BrowGPU: Raytracing complete. Frame presented."
str_globe_stop:  .asciz "BrowGPU: 3D Raytracer stopped. Frame cleared."
str_globe_err:   .asciz "BrowGPU: Hardware accelerator error."
str_unknown:     .asciz "sh: command not found: "
str_halt_msg:    .asciz "System shutting down..."

cmd_help:     .asciz "help"
cmd_ls:       .asciz "ls"
cmd_cd:       .asciz "cd"
cmd_clear:    .asciz "clear"
cmd_uname:    .asciz "uname"
cmd_pwd:      .asciz "pwd"
cmd_uptime:   .asciz "uptime"
cmd_ps:       .asciz "ps"
cmd_echo:     .asciz "echo"
cmd_cat:      .asciz "cat"
cmd_mkdir:    .asciz "mkdir"
cmd_rmdir:    .asciz "rmdir"
cmd_rm:       .asciz "rm"
cmd_touch:    .asciz "touch"
cmd_kill:     .asciz "kill"
cmd_globe:    .asciz "globe"
cmd_shutdown: .asciz "shutdown"
cmd_reboot:   .asciz "reboot"
cmd_exit:     .asciz "exit"

str_help_text:
  .ascii "Available commands:\n"
  .ascii "  help      - Display this help message\n"
  .ascii "  ls        - List directory contents\n"
  .ascii "  cd        - Change current directory\n"
  .ascii "  pwd       - Print current working directory\n"
  .ascii "  mkdir     - Create a directory\n"
  .ascii "  rmdir     - Remove an empty directory\n"
  .ascii "  touch     - Create an empty file\n"
  .ascii "  rm        - Remove a file\n"
  .ascii "  cat       - Concatenate and display file content\n"
  .ascii "  echo      - Print arguments to standard output\n"
  .ascii "  clear     - Clear the terminal screen\n"
  .ascii "  uname     - Print system information\n"
  .ascii "  ps        - Report current process status\n"
  .ascii "  kill      - Terminate a process by PID\n"
  .ascii "  globe     - Toggle 3D raytraced Earth Globe on BrowGPU\n"
  .ascii "  uptime    - Show CPU cycle count\n"
  .asciz "  shutdown  - Halt and power off the machine"

.section .bss
.align 4
globe_active: .zero 4
sh_cwd_buf:   .zero 128
stat_scratch: .zero 32
line_buf:     .zero 256
cat_buf:      .zero 4096
