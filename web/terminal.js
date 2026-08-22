'use strict';

/**
 * terminal.js — Canvas-based ANSI terminal emulator for BrowOS.
 * Renders 80x25 character grid with ANSI escape code support, scrollback history,
 * mouse wheel scrolling, keyboard navigation, and cybernetic UI indicator.
 */

class AnsiTerminal {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [opts]
   * @param {number} [opts.cols] 80
   * @param {number} [opts.rows] 25
   * @param {number} [opts.maxScrollback] 2000
   * @param {function(number):void} [opts.onKey] Callback when key is pressed (byte code).
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas && canvas.getContext ? canvas.getContext('2d') : null;
    this.cols = opts.cols || 80;
    this.rows = opts.rows || 25;
    this.maxScrollback = opts.maxScrollback !== undefined ? opts.maxScrollback : 2000;
    this.onKey = opts.onKey || null;

    this.charWidth = 9;
    this.charHeight = 16;
    if (this.canvas) {
      this.canvas.width = this.cols * this.charWidth;
      this.canvas.height = this.rows * this.charHeight;
    }

    // Terminal buffer: 2D array of { char: ' ', fg: '#00ff66', bg: '#0d1117' }
    this.defaultFg = '#00ff88';
    this.defaultBg = '#0a0e14';
    this.currentFg = this.defaultFg;
    this.currentBg = this.defaultBg;

    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorVisible = true;

    this.buffer = [];
    this.scrollback = [];
    this.scrollOffset = 0; // 0 = viewing live bottom, >0 = scrolled back N lines

    this.clear(true);

    // ANSI escape parsing state
    this.escapeState = 0; // 0=normal, 1=ESC, 2=CSI
    this.csiParams = '';

    // Bind event listeners
    this._initKeyboard();
    this._initMouse();

    // Start cursor blink timer (only when canvas is attached, and unref in Node)
    this.blinkInterval = null;
    if (typeof setInterval !== 'undefined' && this.canvas) {
      this.blinkInterval = setInterval(() => {
        this.cursorVisible = !this.cursorVisible;
        this.render();
      }, 500);
      if (this.blinkInterval && typeof this.blinkInterval.unref === 'function') {
        this.blinkInterval.unref();
      }
    }
  }

  clear(clearScrollback = false) {
    this.buffer = [];
    for (let y = 0; y < this.rows; y++) {
      const row = [];
      for (let x = 0; x < this.cols; x++) {
        row.push({ char: ' ', fg: this.defaultFg, bg: this.defaultBg });
      }
      this.buffer.push(row);
    }
    if (clearScrollback) {
      this.scrollback = [];
    }
    this.scrollOffset = 0;
    this.cursorX = 0;
    this.cursorY = 0;
    this.render();
  }

  scrollBy(delta) {
    this.scrollTo(this.scrollOffset + delta);
  }

  scrollTo(offset) {
    const maxOffset = this.scrollback.length;
    const clamped = Math.max(0, Math.min(maxOffset, Math.floor(offset)));
    if (clamped !== this.scrollOffset) {
      this.scrollOffset = clamped;
      this.render();
    }
  }

  scrollToBottom() {
    this.scrollTo(0);
  }

  scrollToTop() {
    this.scrollTo(this.scrollback.length);
  }

  _getViewportRow(y) {
    const virtualIdx = (this.scrollback.length - this.scrollOffset) + y;
    if (virtualIdx < this.scrollback.length) {
      return this.scrollback[virtualIdx];
    } else {
      const bufferIdx = virtualIdx - this.scrollback.length;
      if (bufferIdx >= 0 && bufferIdx < this.buffer.length) {
        return this.buffer[bufferIdx];
      }
    }
    return null;
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
      } else if (ch === '\b') {
        // Standard BS: Move cursor left without destructive erasure
        if (this.cursorX > 0) {
          this.cursorX--;
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
      if (params === '3') {
        // Clear display & scrollback
        this.clear(true);
      } else if (params === '2' || params === '') {
        // Clear active screen
        this.clear(false);
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
      const codes = params.length === 0 ? [0] : params.split(';').map((p) => parseInt(p, 10) || 0);
      for (const code of codes) {
        if (code === 0) {
          this.currentFg = this.defaultFg;
          this.currentBg = this.defaultBg;
        } else if (code === 30) this.currentFg = '#21222c';
        else if (code === 31) this.currentFg = '#ff5555';
        else if (code === 32) this.currentFg = '#50fa7b';
        else if (code === 33) this.currentFg = '#f1fa8c';
        else if (code === 34) this.currentFg = '#bd93f9';
        else if (code === 35) this.currentFg = '#ff79c6';
        else if (code === 36) this.currentFg = '#8be9fd';
        else if (code === 37) this.currentFg = '#f8f8f2';
        else if (code === 39) this.currentFg = this.defaultFg;
        else if (code === 40) this.currentBg = '#21222c';
        else if (code === 41) this.currentBg = '#ff5555';
        else if (code === 42) this.currentBg = '#50fa7b';
        else if (code === 43) this.currentBg = '#f1fa8c';
        else if (code === 44) this.currentBg = '#bd93f9';
        else if (code === 45) this.currentBg = '#ff79c6';
        else if (code === 46) this.currentBg = '#8be9fd';
        else if (code === 47) this.currentBg = '#f8f8f2';
        else if (code === 49) this.currentBg = this.defaultBg;
        else if (code === 90) this.currentFg = '#6272a4';
        else if (code === 91) this.currentFg = '#ff6e6e';
        else if (code === 92) this.currentFg = '#69ff94';
        else if (code === 93) this.currentFg = '#ffffa5';
        else if (code === 94) this.currentFg = '#d6acff';
        else if (code === 95) this.currentFg = '#ff92df';
        else if (code === 96) this.currentFg = '#a4ffff';
        else if (code === 97) this.currentFg = '#ffffff';
        else if (code === 100) this.currentBg = '#6272a4';
        else if (code === 101) this.currentBg = '#ff6e6e';
        else if (code === 102) this.currentBg = '#69ff94';
        else if (code === 103) this.currentBg = '#ffffa5';
        else if (code === 104) this.currentBg = '#d6acff';
        else if (code === 105) this.currentBg = '#ff92df';
        else if (code === 106) this.currentBg = '#a4ffff';
        else if (code === 107) this.currentBg = '#ffffff';
      }
    }
  }

  _scroll() {
    const shiftedRow = this.buffer.shift();
    if (this.maxScrollback > 0 && shiftedRow) {
      this.scrollback.push(shiftedRow);
      if (this.scrollback.length > this.maxScrollback) {
        this.scrollback.shift();
      }
    }
    // If the user is scrolled back viewing history, adjust offset so content stays stationary
    if (this.scrollOffset > 0) {
      this.scrollOffset = Math.min(this.scrollback.length, this.scrollOffset + 1);
    }

    const newRow = [];
    for (let x = 0; x < this.cols; x++) {
      newRow.push({ char: ' ', fg: this.defaultFg, bg: this.defaultBg });
    }
    this.buffer.push(newRow);
  }

  render() {
    if (!this.ctx || !this.canvas) return;
    const ctx = this.ctx;
    ctx.fillStyle = this.defaultBg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.font = '14px "JetBrains Mono", "Fira Code", "Courier New", monospace';
    ctx.textBaseline = 'top';

    for (let y = 0; y < this.rows; y++) {
      const row = this._getViewportRow(y);
      if (!row) continue;

      const py = y * this.charHeight;
      for (let x = 0; x < this.cols; x++) {
        const cell = row[x];
        if (!cell) continue;
        const px = x * this.charWidth;

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

    // Render cursor (adjusted for scroll offset)
    const onScreenCursorY = this.cursorY + this.scrollOffset;
    if (
      this.cursorVisible &&
      this.cursorX < this.cols &&
      onScreenCursorY >= 0 &&
      onScreenCursorY < this.rows
    ) {
      const cx = this.cursorX * this.charWidth;
      const cy = onScreenCursorY * this.charHeight;
      ctx.fillStyle = this.currentFg;
      ctx.fillRect(cx, cy + this.charHeight - 3, this.charWidth, 3);
    }

    // Render Scrollbar Track and Thumb
    if (this.scrollback.length > 0) {
      const trackWidth = 5;
      const trackX = this.canvas.width - trackWidth - 2;
      const trackY = 2;
      const trackHeight = this.canvas.height - 4;

      // Draw subtle track
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fillRect(trackX, trackY, trackWidth, trackHeight);

      // Compute thumb dimensions
      const totalLines = this.scrollback.length + this.rows;
      const thumbHeight = Math.max(14, (this.rows / totalLines) * trackHeight);
      const maxThumbTravel = trackHeight - thumbHeight;
      const scrollRatio = (this.scrollback.length - this.scrollOffset) / this.scrollback.length;
      const thumbY = trackY + scrollRatio * maxThumbTravel;

      // Draw thumb
      ctx.fillStyle = this.scrollOffset > 0 ? '#00ff88' : 'rgba(0, 255, 136, 0.35)';
      ctx.fillRect(trackX, thumbY, trackWidth, thumbHeight);
    }

    // Render Scrolled-Back Indicator Badge
    if (this.scrollOffset > 0) {
      const badgeText = `▲ SCROLL: +${this.scrollOffset}`;
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      const textMetrics = ctx.measureText(badgeText);
      const badgeW = textMetrics.width + 16;
      const badgeH = 20;
      const badgeX = this.canvas.width - badgeW - 14;
      const badgeY = 8;

      ctx.fillStyle = 'rgba(10, 14, 20, 0.9)';
      ctx.fillRect(badgeX, badgeY, badgeW, badgeH);

      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 1;
      ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

      ctx.fillStyle = '#00ff88';
      ctx.fillText(badgeText, badgeX + 8, badgeY + 4);
    }
  }

  _initMouse() {
    if (!this.canvas || !this.canvas.addEventListener) return;

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // deltaY < 0 is scroll up -> increase scroll offset (view history)
        // deltaY > 0 is scroll down -> decrease scroll offset (towards live screen)
        const step = (e.deltaY < 0 ? 1 : -1) * 3;
        this.scrollBy(step);
      },
      { passive: false }
    );
  }

  _initKeyboard() {
    if (typeof window === 'undefined' || !window.addEventListener) return;

    window.addEventListener('keydown', (e) => {
      // Don't intercept if user is in an input field outside canvas
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

      // Terminal Navigation shortcuts
      if (e.shiftKey) {
        if (e.key === 'PageUp') {
          e.preventDefault();
          this.scrollBy(this.rows - 2);
          return;
        }
        if (e.key === 'PageDown') {
          e.preventDefault();
          this.scrollBy(-(this.rows - 2));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.scrollBy(1);
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.scrollBy(-1);
          return;
        }
        if (e.key === 'Home') {
          e.preventDefault();
          this.scrollToTop();
          return;
        }
        if (e.key === 'End') {
          e.preventDefault();
          this.scrollToBottom();
          return;
        }
      }

      // PageUp / PageDown without shift also scroll history
      if (e.key === 'PageUp') {
        e.preventDefault();
        this.scrollBy(this.rows - 2);
        return;
      }
      if (e.key === 'PageDown') {
        e.preventDefault();
        this.scrollBy(-(this.rows - 2));
        return;
      }

      if (e.ctrlKey) {
        if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          this.scrollToBottom();
          if (this.onKey) this.onKey(0x03); // ETX (Ctrl+C)
          return;
        }
        if (e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          this.scrollToBottom();
          if (this.onKey) this.onKey(0x04); // EOT (Ctrl+D)
          return;
        }
        if (e.key === 'l' || e.key === 'L') {
          e.preventDefault();
          this.scrollToBottom();
          if (this.onKey) this.onKey(0x0C); // FF (Ctrl+L)
          return;
        }
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        this.scrollToBottom();
        if (this.onKey) this.onKey(10); // '\n'
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        this.scrollToBottom();
        if (this.onKey) this.onKey(8); // '\b'
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.scrollToBottom();
        if (this.onKey) this.onKey(9); // '\t'
        return;
      }

      if (e.key.length === 1 && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        this.scrollToBottom();
        const code = e.key.charCodeAt(0);
        if (code >= 32 && code < 127) {
          if (this.onKey) this.onKey(code);
        }
      }
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AnsiTerminal };
}
