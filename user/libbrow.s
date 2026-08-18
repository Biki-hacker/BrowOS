# libbrow.s - Userland Runtime Library for BrowOS.
# Standard syscall wrappers, string routines, and console I/O.

.section .text
.align 2

# ─── Syscall Wrappers ──────────────────────────────────────────────────
.global exit
.global yield
.global sleep
.global getpid
.global write
.global read
.global open
.global close
.global stat
.global mkdir
.global unlink
.global exec
.global halt

exit:
  li a7, 1
  ecall
  ret

yield:
  li a7, 3
  ecall
  ret

sleep:
  li a7, 4
  ecall
  ret

getpid:
  li a7, 5
  ecall
  ret

write:
  li a7, 6
  ecall
  ret

read:
  li a7, 7
  ecall
  ret

open:
  li a7, 8
  ecall
  ret

close:
  li a7, 9
  ecall
  ret

stat:
  li a7, 10
  ecall
  ret

mkdir:
  li a7, 11
  ecall
  ret

unlink:
  li a7, 12
  ecall
  ret

exec:
  li a7, 13
  ecall
  ret

halt:
  li a7, 15
  ecall
  ret

# ─── String and Memory Functions ───────────────────────────────────────
.global strlen
.global strcmp
.global strncmp
.global strcpy
.global memcpy
.global memset

# strlen(a0=str): Returns string length in a0.
strlen:
  li t0, 0
strlen_loop:
  add t1, a0, t0
  lbu t2, 0(t1)
  beqz t2, strlen_done
  addi t0, t0, 1
  j strlen_loop
strlen_done:
  mv a0, t0
  ret

# strcmp(a0=s1, a1=s2): Returns 0 if equal, difference otherwise.
strcmp:
  li t0, 0
strcmp_loop:
  add t1, a0, t0
  add t2, a1, t0
  lbu t3, 0(t1)
  lbu t4, 0(t2)
  bne t3, t4, strcmp_diff
  beqz t3, strcmp_eq
  addi t0, t0, 1
  j strcmp_loop
strcmp_diff:
  sub a0, t3, t4
  ret
strcmp_eq:
  li a0, 0
  ret

# strncmp(a0=s1, a1=s2, a2=n): Compares up to n characters.
strncmp:
  beqz a2, strncmp_eq
  li t0, 0
strncmp_loop:
  bge t0, a2, strncmp_eq
  add t1, a0, t0
  add t2, a1, t0
  lbu t3, 0(t1)
  lbu t4, 0(t2)
  bne t3, t4, strncmp_diff
  beqz t3, strncmp_eq
  addi t0, t0, 1
  j strncmp_loop
strncmp_diff:
  sub a0, t3, t4
  ret
strncmp_eq:
  li a0, 0
  ret

# strcpy(a0=dst, a1=src): Copies src to dst including null terminator.
strcpy:
  mv t0, a0
  mv t1, a1
strcpy_loop:
  lbu t2, 0(t1)
  sb t2, 0(t0)
  beqz t2, strcpy_done
  addi t0, t0, 1
  addi t1, t1, 1
  j strcpy_loop
strcpy_done:
  ret

# memcpy(a0=dst, a1=src, a2=n): Copies n bytes.
memcpy:
  li t0, 0
memcpy_loop:
  bge t0, a2, memcpy_done
  add t1, a1, t0
  add t2, a0, t0
  lbu t3, 0(t1)
  sb t3, 0(t2)
  addi t0, t0, 1
  j memcpy_loop
memcpy_done:
  ret

# memset(a0=dst, a1=val, a2=n): Fills n bytes.
memset:
  li t0, 0
memset_loop:
  bge t0, a2, memset_done
  add t1, a0, t0
  sb a1, 0(t1)
  addi t0, t0, 1
  j memset_loop
memset_done:
  ret

# ─── Console I/O Routines ──────────────────────────────────────────────
.global putchar
.global print
.global puts
.global print_num
.global print_hex
.global readline

# putchar(a0=char): Writes a single character to stdout (fd 1).
putchar:
  addi sp, sp, -8
  sw ra, 4(sp)
  sb a0, 0(sp)
  li a0, 1         # fd 1 (stdout)
  mv a1, sp        # buf pointer
  li a2, 1         # count = 1
  call write
  lw ra, 4(sp)
  addi sp, sp, 8
  ret

# print(a0=str): Writes string to stdout without trailing newline.
print:
  addi sp, sp, -12
  sw ra, 8(sp)
  sw s0, 4(sp)
  sw s1, 0(sp)
  mv s0, a0
  call strlen
  mv a2, a0        # count = strlen(s)
  beqz a2, print_done
  li a0, 1         # fd 1
  mv a1, s0        # buf
  call write
print_done:
  lw s1, 0(sp)
  lw s0, 4(sp)
  lw ra, 8(sp)
  addi sp, sp, 12
  ret

# puts(a0=str): Writes string with trailing newline to stdout.
puts:
  addi sp, sp, -8
  sw ra, 4(sp)
  call print
  li a0, '\n'
  call putchar
  lw ra, 4(sp)
  addi sp, sp, 8
  ret

# print_num(a0=int): Prints decimal representation of a signed 32-bit integer.
print_num:
  addi sp, sp, -32
  sw ra, 28(sp)
  sw s0, 24(sp)
  sw s1, 20(sp)

  mv s0, a0
  bgez s0, print_num_pos
  # Negative: print '-' and negate
  li a0, '-'
  call putchar
  neg s0, s0

print_num_pos:
  # Fill digits into stack buffer backwards
  addi s1, sp, 16  # end of buffer
  sb x0, 0(s1)     # null terminator
  li t0, 10

print_num_loop:
  remu t1, s0, t0  # digit
  divu s0, s0, t0  # s0 /= 10
  addi t1, t1, '0'
  addi s1, s1, -1
  sb t1, 0(s1)
  bnez s0, print_num_loop

  mv a0, s1
  call print

  lw s1, 20(sp)
  lw s0, 24(sp)
  lw ra, 28(sp)
  addi sp, sp, 32
  ret

# print_hex(a0=uint32): Prints 8-digit hexadecimal representation.
print_hex:
  addi sp, sp, -16
  sw ra, 12(sp)
  sw s0, 8(sp)
  sw s1, 4(sp)

  mv s0, a0
  li s1, 28        # shift amount: 28, 24, ... 0

print_hex_loop:
  bltz s1, print_hex_done
  srl t0, s0, s1
  andi t0, t0, 0xF
  li t1, 10
  blt t0, t1, print_hex_dec
  addi t0, t0, 55  # 'A' - 10 = 65 - 10 = 55
  j print_hex_emit
print_hex_dec:
  addi t0, t0, '0'
print_hex_emit:
  mv a0, t0
  call putchar
  addi s1, s1, -4
  j print_hex_loop

print_hex_done:
  lw s1, 4(sp)
  lw s0, 8(sp)
  lw ra, 12(sp)
  addi sp, sp, 16
  ret

# readline(a0=buf, a1=max_len): Reads line from stdin with echo.
# Supports backspace (0x08 and 0x7F) and stops on newline ('\n' / '\r').
# Returns length in a0.
readline:
  addi sp, sp, -24
  sw ra, 20(sp)
  sw s0, 16(sp)
  sw s1, 12(sp)
  sw s2, 8(sp)
  sw s3, 4(sp)

  mv s0, a0        # s0 = buf
  mv s1, a1        # s1 = max_len
  li s2, 0         # s2 = current count

readline_loop:
  # Read single char from stdin (fd 0)
  li a0, 0
  addi a1, sp, 0   # char scratch on stack
  li a2, 1
  call read
  beqz a0, readline_loop # no char ready, poll again

  lbu s3, 0(sp)    # s3 = char read

  # Check newline / carriage return
  li t0, '\n'
  beq s3, t0, readline_eol
  li t0, '\r'
  beq s3, t0, readline_eol

  # Check backspace (BS=8, DEL=127)
  li t0, 8
  beq s3, t0, readline_bs
  li t0, 127
  beq s3, t0, readline_bs

  # Regular printable char
  addi t0, s1, -1
  bge s2, t0, readline_loop # buffer full, ignore

  # Store in buffer
  add t0, s0, s2
  sb s3, 0(t0)
  addi s2, s2, 1

  # Echo char
  mv a0, s3
  call putchar
  j readline_loop

readline_bs:
  beqz s2, readline_loop # nothing to erase
  addi s2, s2, -1
  # Erase on screen: \b \b
  li a0, 8
  call putchar
  li a0, ' '
  call putchar
  li a0, 8
  call putchar
  j readline_loop

readline_eol:
  # Echo newline
  li a0, '\n'
  call putchar

  # Null-terminate
  add t0, s0, s2
  sb x0, 0(t0)

  mv a0, s2        # return length
  lw s3, 4(sp)
  lw s2, 8(sp)
  lw s1, 12(sp)
  lw s0, 16(sp)
  lw ra, 20(sp)
  addi sp, sp, 24
  ret
