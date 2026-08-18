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
  # Print prompt
  la a0, str_prompt
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
  bnez a0, sh_try_clear
  la a0, str_help_text
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
  bnez a0, sh_try_pwd
  la a0, str_uname_text
  call puts
  j sh_loop

sh_try_pwd:
  # ─── Built-in: pwd ───────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_pwd
  call strcmp
  bnez a0, sh_try_uptime
  la a0, str_slash
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
  # Skip "echo" and spaces
  addi a0, s0, 4
sh_echo_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_echo_print
  addi a0, a0, 1
  j sh_echo_sp
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
  li a2, 255
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
  bnez a0, sh_try_rm
  addi a0, s0, 5
sh_mkdir_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_mkdir_do
  addi a0, a0, 1
  j sh_mkdir_sp
sh_mkdir_do:
  call mkdir
  bnez a0, sh_mkdir_err
  j sh_loop
sh_mkdir_err:
  la a0, str_mkdir_err
  call puts
  j sh_loop

sh_try_rm:
  # ─── Built-in: rm <file> ─────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_rm
  li a2, 2
  call strncmp
  bnez a0, sh_try_touch
  addi a0, s0, 2
sh_rm_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_rm_do
  addi a0, a0, 1
  j sh_rm_sp
sh_rm_do:
  call unlink
  bnez a0, sh_rm_err
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
  addi a0, s0, 5
sh_touch_sp:
  lbu t0, 0(a0)
  li t1, ' '
  bne t0, t1, sh_touch_do
  addi a0, a0, 1
  j sh_touch_sp
sh_touch_do:
  li a1, 1         # create flag
  call open
  li t0, -1
  beq a0, t0, sh_touch_err
  call close
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
  li t1, ' '
  beq t0, t1, sh_kill_do
  li t1, '0'
  blt t0, t1, sh_kill_do
  li t1, '9'
  bgt t0, t1, sh_kill_do
  addi t0, t0, -48
  li t1, 10
  mul t2, t2, t1
  add t2, t2, t0
  addi a0, a0, 1
  j sh_kill_digit_loop
sh_kill_do:
  mv a0, t2        # pid
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
  # ─── Built-in: globe ─────────────────────────────────────────────────
  mv a0, s0
  la a1, cmd_globe
  call strcmp
  bnez a0, sh_try_halt
  la a0, str_globe_msg
  call puts
  # Dispatch 3D compute raytracer on BrowGPU
  li a0, 3           # op = GPU_OP_DISPATCH_COMPUTE
  li a1, 1           # kernel_id = 1 (raytrace_globe)
  li a2, 10          # time
  li a3, 0
  call gpu_dispatch
  # Present framebuffer
  li a0, 4           # op = GPU_OP_PRESENT
  call gpu_dispatch
  la a0, str_globe_done
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

  # Unknown command
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
str_prompt:      .asciz "browos$ "
str_slash:       .asciz "/"
str_clear_seq:   .asciz "\x1b[2J\x1b[H"
str_uname_text:  .asciz "BrowOS 0.1.0 rv32im (Sv32 MMU)"
str_uptime_msg:  .asciz "up "
str_cycles_msg:  .asciz " cycles"
str_ps_header:   .asciz "  PID  TTY  STAT  COMMAND"
str_ps_entry:    .asciz "    "
str_ps_running:  .asciz "  tty1  R     sh"
str_cat_usage:   .asciz "cat: missing file argument"
str_cat_notfound:.asciz "cat: file not found"
str_mkdir_err:   .asciz "mkdir: failed to create directory"
str_rm_err:      .asciz "rm: failed to remove file"
str_touch_err:   .asciz "touch: failed to create file"
str_kill_usage:  .asciz "kill: missing pid argument"
str_kill_err:    .asciz "kill: process not found"
str_globe_msg:   .asciz "BrowGPU: Computing 3D Raytraced Earth Globe..."
str_globe_done:  .asciz "BrowGPU: Raytracing complete. Frame presented."
str_unknown:     .asciz "sh: command not found: "
str_halt_msg:    .asciz "System shutting down..."

cmd_help:     .asciz "help"
cmd_clear:    .asciz "clear"
cmd_uname:    .asciz "uname"
cmd_pwd:      .asciz "pwd"
cmd_uptime:   .asciz "uptime"
cmd_ps:       .asciz "ps"
cmd_echo:     .asciz "echo"
cmd_cat:      .asciz "cat"
cmd_mkdir:    .asciz "mkdir"
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
  .ascii "  clear     - Clear the terminal screen\n"
  .ascii "  uname     - Print system information\n"
  .ascii "  pwd       - Print current working directory\n"
  .ascii "  echo      - Print arguments to standard output\n"
  .ascii "  cat       - Concatenate and display file content\n"
  .ascii "  mkdir     - Create a directory\n"
  .ascii "  touch     - Create an empty file\n"
  .ascii "  rm        - Remove a file\n"
  .ascii "  ps        - Report current process status\n"
  .ascii "  kill      - Terminate a process by PID\n"
  .ascii "  globe     - Compute and render 3D raytraced Earth on BrowGPU\n"
  .ascii "  uptime    - Show CPU cycle count\n"
  .asciz "  shutdown  - Halt and power off the machine"

.section .bss
.align 4
line_buf: .zero 256
cat_buf:  .zero 256
