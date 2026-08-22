# 0-memmap.s - physical memory map constants.
# Kept in sync with tools/memmap.js. No code, only .equ definitions.

# RAM
.equ RAM_BASE,     0x00000000
.equ RAM_SIZE,     0x10000000
.equ FRAME_SIZE,   0x00001000
.equ NFRAMES,      0x00010000
.equ KERNEL_LINK,  0x00000000
.equ KERNEL_FRAMES, 0x00000200
.equ KERNEL_MAX,   0x00100000

# Kernel heap (kmalloc arena, 1 MiB)
.equ HEAP_START,   0x00100000
.equ HEAP_END,     0x00200000

# Machine timer (CLINT: msip + mtime)
.equ CLINT_BASE,   0x02000000

# Future device block
.equ UART_BASE,    0x10000000
.equ TIMER_BASE,   0x10001000
.equ INTC_BASE,    0x10002000
.equ BLOCK_BASE,   0x10003000
.equ GPU_CTRL_BASE, 0x10004000
.equ GPU_CMD_BASE, 0x10005000
.equ MMIO_END,     0xFFFFF000

# Sv32 PTE flags
.equ PTE_V,        0x01
.equ PTE_R,        0x02
.equ PTE_W,        0x04
.equ PTE_X,        0x08
.equ PTE_U,        0x10
.equ PTE_G,        0x20
.equ PTE_A,        0x40
.equ PTE_D,        0x80
.equ PTE_KERN_DATA, 0xC7
.equ PTE_KERN_TEXT, 0xCB
.equ PTE_USER_DATA, 0xD7
.equ PTE_USER_TEXT, 0xDB

# Syscall numbers
.equ SYS_EXIT,     1
.equ SYS_FORK,     2
.equ SYS_YIELD,    3
.equ SYS_SLEEP,    4
.equ SYS_GETPID,   5
.equ SYS_WRITE,    6
.equ SYS_READ,     7
.equ SYS_OPEN,     8
.equ SYS_CLOSE,    9
.equ SYS_STAT,     10
.equ SYS_MKDIR,    11
.equ SYS_UNLINK,   12
.equ SYS_EXEC,     13
.equ SYS_DUP,      14
.equ SYS_HALT,     15
.equ SYS_PIPE,     16
.equ SYS_KILL,     17
.equ SYS_WAITPID,  18
.equ SYS_GPU,      19
.equ SYS_CHDIR,    20
.equ SYS_GETCWD,   21
.equ SYS_LSEEK,    22

# Signal numbers
.equ SIGINT,       2
.equ SIGKILL,      9
.equ SIGTERM,      15
.equ SIGCHLD,      17

# User Virtual Addresses
.equ USER_TEXT_VA,  0x40000000
.equ USER_STACK_VA, 0x7FFFF000
.equ USER_STACK_TOP,0x80000000

# BrowGPU register offsets
.equ GPU_REG_MAGIC,    0x00
.equ GPU_REG_VERSION,  0x04
.equ GPU_REG_STATUS,   0x08
.equ GPU_REG_FB_WIDTH, 0x0C
.equ GPU_REG_FB_HEIGHT,0x10
.equ GPU_REG_FB_ADDR,  0x14
.equ GPU_REG_CMD_ADDR, 0x18
.equ GPU_REG_CMD_LEN,  0x1C
.equ GPU_REG_SUBMIT,   0x20
.equ GPU_REG_PRESENT,  0x24
.equ GPU_REG_BACKEND,  0x28

.equ GPU_MAGIC,        0x42475055
.equ GPU_VERSION,      0x00010000

# BrowGPU command opcodes
.equ CMD_CLEAR,            1
.equ CMD_DRAW_RECT,        2
.equ CMD_BLIT,             3
.equ CMD_DISPATCH_COMPUTE, 4
.equ CMD_PRESENT,          5

# UART 16550A register offsets
.equ UART_RBR,     0x00
.equ UART_THR,     0x00
.equ UART_IER,     0x01
.equ UART_FCR,     0x02
.equ UART_LCR,     0x03
.equ UART_MCR,     0x04
.equ UART_LSR,     0x05
.equ UART_MSR,     0x06
.equ UART_SCR,     0x07
.equ LSR_DATA_READY, 0x01
.equ LSR_TX_EMPTY, 0x20

# Block device register offsets
.equ BLK_STATUS,   0x00
.equ BLK_COMMAND,  0x04
.equ BLK_SECTOR,   0x08
.equ BLK_DMA_ADDR, 0x0C
.equ BLK_CAPACITY, 0x10
.equ BLK_SECT_SIZE, 0x14
.equ BLK_CMD_READ, 1
.equ BLK_CMD_WRITE, 2
.equ BLK_SECTOR_SIZE, 512

# BrFS filesystem constants
.equ BRFS_MAGIC,       0x42524653
.equ BRFS_BLOCK_SIZE,  4096
.equ BRFS_SECTS_PER_BLK, 8
.equ BRFS_MAX_INODES,  128
.equ BRFS_MAX_DIRECT,  12
.equ BRFS_INODE_FILE,  1
.equ BRFS_INODE_DIR,   2
.equ BRFS_NAME_MAX,    28

# Process states
.equ PROC_UNUSED,   0
.equ PROC_RUNNABLE, 1
.equ PROC_RUNNING,  2
.equ PROC_SLEEPING, 3
.equ PROC_ZOMBIE,   4

# Max processes
.equ MAX_PROCS,    16

# Trapframe register offsets
.equ TF_RA,        4
.equ TF_SP,        8
.equ TF_GP,        12
.equ TF_TP,        16
.equ TF_T0,        20
.equ TF_T1,        24
.equ TF_T2,        28
.equ TF_S0,        32
.equ TF_S1,        36
.equ TF_A0,        40
.equ TF_A1,        44
.equ TF_A2,        48
.equ TF_A3,        52
.equ TF_A4,        56
.equ TF_A5,        60
.equ TF_A6,        64
.equ TF_A7,        68
.equ TF_S2,        72
.equ TF_S3,        76
.equ TF_S4,        80
.equ TF_S5,        84
.equ TF_S6,        88
.equ TF_S7,        92
.equ TF_S8,        96
.equ TF_S9,        100
.equ TF_S10,       104
.equ TF_S11,       108
.equ TF_T3,        112
.equ TF_T4,        116
.equ TF_T5,        120
.equ TF_T6,        124
.equ TF_EPC,       128
.equ TF_STATUS,    132
.equ TF_CAUSE,     136
.equ TF_TVAL,      140
.equ TF_SIZE,      144

# PCB offsets
.equ PCB_STATE,      0
.equ PCB_PID,        4
.equ PCB_PPID,       8
.equ PCB_PRIORITY,   12
.equ PCB_SATP,       16
.equ PCB_KSTACK,     20
.equ PCB_USTACK,     24
.equ PCB_TF,         28
.equ PCB_EXITCODE,   32
.equ PCB_SLEEPTICKS, 36
.equ PCB_CWD,        40
.equ PCB_SIZE,       44

# Open-file table (per process)
.equ OF_TYPE,    0
.equ OF_INODE,   4
.equ OF_OFFSET,  8
.equ OF_FLAGS,   12
.equ OF_SIZE,    16
.equ MAX_OFILES, 16

# open(2) flags
.equ O_CREATE,  1
.equ O_TRUNC,   2
.equ O_APPEND,  4