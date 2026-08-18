'use strict';

/**
 * terminal.js — Canvas-based ANSI terminal emulator for BrowOS.
 * Renders 80x25 character grid with ANSI escape code support and keyboard event capture.
 */

class AnsiTerminal {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {number} [opts.cols] 80
   * @param {number} [opts.rows] 25
   * @param {function(number):void} [opts.onKey] Callback when key is pressed (byte code).
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 25;
    this.onKey = opts.onKey || null;

    this.charWidth = 9;
    this.charHeight = 16;
    this.canvas.width = this.cols * this.charWidth;
    this.canvas.height = this.rows * this.charHeight;

    // Terminal buffer: 2D array of { char: ' ', fg: '#00ff66', bg: '#0d1117' }
    this.defaultFg = '#00ff88';
    this.defaultBg = '#0a0e14';
    this.currentFg = this.defaultFg;
    this.currentBg = this.defaultBg;

    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorVisible = true;

    this.buffer = [];
    this.clear();

    // ANSI escape parsing state
    this.escapeState = 0; // 0=normal, 1=ESC, 2=CSI
    this.csiParams = '';

    // Bind keyboard
    this._initKeyboard();

    // Start cursor blink timer
    setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
      this.render();
    }, 500);
  }

  clear() {
    this.buffer = [];
    for (let y = 0; y < this.rows; y++) {
      const row = [];
      for (let x = 0; x < this.cols; x++) {
        row.push({ char: ' ', fg: this.defaultFg, bg: this.defaultBg });
      }
      this.buffer.push(row);
    }
    this.cursorX = 0;
    this.cursorY = 0;
    this.render();
  }

  write(str) {
    for (let i = 0; i < str.length; i++) {
      this.writeChar(str[i]);
    }
    this.render();
  }

  writeChar(ch) {
    if (this.escapeState === 0) {
      if (ch === '\x1b') {
        this.escapeState = 1;
      } else if (ch === '\r') {
        this.cursorX = 0;
      } else if (ch === '\n') {
        this.cursorX = 0;
        this.cursorY++;
        if (this.cursorY >= this.rows) {
          this._scroll();
          this.cursorY = this.rows - 1;
        }
      } else if (ch === '\b' || ch === '\x7f') {
        if (this.cursorX > 0) {
          this.cursorX--;
          this.buffer[this.cursorY][this.cursorX] = { char: ' ', fg: this.currentFg, bg: this.currentBg };
        }
      } else if (ch === '\t') {
        this.cursorX = (this.cursorX + 4) & ~3;
        if (this.cursorX >= this.cols) {
          this.cursorX = 0;
          this.cursorY++;
          if (this.cursorY >= this.rows) {
            this._scroll();
            this.cursorY = this.rows - 1;
          }
        }
      } else {
        if (this.cursorX >= this.cols) {
          this.cursorX = 0;
          this.cursorY++;
          if (this.cursorY >= this.rows) {
            this._scroll();
            this.cursorY = this.rows - 1;
          }
        }
        this.buffer[this.cursorY][this.cursorX] = {
          char: ch,
          fg: this.currentFg,
          bg: this.currentBg,
        };
        this.cursorX++;
      }
    } else if (this.escapeState === 1) {
      if (ch === '[') {
        this.escapeState = 2;
        this.csiParams = '';
      } else {
        this.escapeState = 0;
      }
    } else if (this.escapeState === 2) {
      if ((ch >= '0' && ch <= '9') || ch === ';') {
        this.csiParams += ch;
      } else {
        this._handleCsi(ch, this.csiParams);
        this.escapeState = 0;
      }
    }
  }

  _handleCsi(cmd, params) {
    if (cmd === 'J') {
      // Clear display
      if (params === '2' || params === '') {
        this.clear();
      }
    } else if (cmd === 'H' || cmd === 'f') {
      // Move cursor home
      const parts = params.split(';');
      const r = parts[0] ? Math.max(0, parseInt(parts[0], 10) - 1) : 0;
      const c = parts[1] ? Math.max(0, parseInt(parts[1], 10) - 1) : 0;
      this.cursorY = Math.min(this.rows - 1, r);
      this.cursorX = Math.min(this.cols - 1, c);
    } else if (cmd === 'm') {
      // SGR Color codes
      const codes = params.split(';').map((p) => parseInt(p, 10) || 0);
      for (const code of codes) {
        if (code === 0) {
          this.currentFg = this.defaultFg;
          this.currentBg = this.defaultBg;
        } else if (code === 30) this.currentFg = '#000000';
        else if (code === 31) this.currentFg = '#ff5555';
        else if (code === 32) this.currentFg = '#50fa7b';
        else if (code === 33) this.currentFg = '#f1fa8c';
        else if (code === 34) this.currentFg = '#bd93f9';
        else if (code === 35) this.currentFg = '#ff79c6';
        else if (code === 36) this.currentFg = '#8be9fd';
        else if (code === 37) this.currentFg = '#ffffff';
      }
    }
  }

  _scroll() {
    this.buffer.shift();
    const newRow = [];
    for (let x = 0; x < this.cols; x++) {
      newRow.push({ char: ' ', fg: this.defaultFg, bg: this.defaultBg });
    }
    this.buffer.push(newRow);
  }

  render() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    ctx.fillStyle = this.defaultBg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.font = '14px "JetBrains Mono", "Fira Code", "Courier New", monospace';
    ctx.textBaseline = 'top';

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const cell = this.buffer[y][x];
        const px = x * this.charWidth;
        const py = y * this.charHeight;

        if (cell.bg !== this.defaultBg) {
          ctx.fillStyle = cell.bg;
          ctx.fillRect(px, py, this.charWidth, this.charHeight);
        }

        if (cell.char !== ' ') {
          ctx.fillStyle = cell.fg;
          ctx.fillText(cell.char, px, py);
        }
      }
    }

    // Render cursor
    if (this.cursorVisible && this.cursorX < this.cols && this.cursorY < this.rows) {
      const cx = this.cursorX * this.charWidth;
      const cy = this.cursorY * this.charHeight;
      ctx.fillStyle = this.currentFg;
      ctx.fillRect(cx, cy + this.charHeight - 3, this.charWidth, 3);
    }
  }

  _initKeyboard() {
    window.addEventListener('keydown', (e) => {
      // Don't intercept if user is in an input field outside canvas
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

      if (e.ctrlKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          if (this.onKey) this.onKey(0x03); // ETX (Ctrl+C)
          return;
        }
        if (e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          if (this.onKey) this.onKey(0x04); // EOT (Ctrl+D)
          return;
        }
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          if (this.onKey) this.onKey(0x0C); // FF (Ctrl+L)
          return;
        }
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.onKey) this.onKey(10); // '\n'
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (this.onKey) this.onKey(8);  // '\b'
      } else if (e.key === 'Tab') {
        e.preventDefault();
        if (this.onKey) this.onKey(9);  // '\t'
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        // Up arrow ANSI sequence: \x1b[A
        if (this.onKey) {
          this.onKey(0x1b); this.onKey(0x5b); this.onKey(0x41);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        // Down arrow ANSI sequence: \x1b[B
        if (this.onKey) {
          this.onKey(0x1b); this.onKey(0x5b); this.onKey(0x42);
        }
      } else if (e.key.length === 1 && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (this.onKey) this.onKey(e.key.charCodeAt(0));
      }
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AnsiTerminal };
}
