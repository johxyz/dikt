#!/usr/bin/env node
// dikt — voice dictation for the terminal
// Zero npm dependencies. Node.js built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const ESC = '\x1b[';
let RESET = `${ESC}0m`;
let BOLD = `${ESC}1m`;
let DIM = `${ESC}2m`;
let RED = `${ESC}31m`;
let GREEN = `${ESC}32m`;
let YELLOW = `${ESC}33m`;
let BLUE = `${ESC}34m`;
let MAGENTA = `${ESC}35m`;
let CYAN = `${ESC}36m`;
let GREY = `${ESC}90m`;
let WHITE = `${ESC}37m`;
let RED_BG = `${ESC}41m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;
const CLEAR_DOWN = `${ESC}J`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;

if (process.env.NO_COLOR != null || process.env.TERM === 'dumb' || process.argv.includes('--no-color')) {
  RESET = BOLD = DIM = RED = GREEN = YELLOW = BLUE = MAGENTA = CYAN = GREY = WHITE = RED_BG = '';
}

const moveTo = (row, col = 1) => `${ESC}${row};${col}H`;

// ── Constants ─────────────────────────────────────────────────────────────────

const VERSION = '1.2.0';
const CONFIG_BASE = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const CONFIG_DIR = path.join(CONFIG_BASE, 'dikt');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const MAX_HISTORY = 10;
const MIN_RECORDING_MS = 500;
const COST_PER_MIN = 0.003;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const EXIT_OK = 0;
const EXIT_DEPENDENCY = 1;
const EXIT_NO_TTY = 2;
const EXIT_CONFIG = 3;
const EXIT_TRANSCRIPTION = 4;

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function applyEnvOverrides(cfg) {
  if (process.env.DIKT_API_KEY) cfg.apiKey = process.env.DIKT_API_KEY;
  if (process.env.DIKT_MODEL) cfg.model = process.env.DIKT_MODEL;
  if (process.env.DIKT_LANGUAGE) cfg.language = process.env.DIKT_LANGUAGE;
  if (process.env.DIKT_TEMPERATURE) cfg.temperature = parseFloat(process.env.DIKT_TEMPERATURE);
  if (process.env.DIKT_CONTEXT_BIAS) cfg.contextBias = process.env.DIKT_CONTEXT_BIAS;
}

function validateConfig(cfg) {
  const errors = [];
  if (!cfg.apiKey || typeof cfg.apiKey !== 'string') {
    errors.push('apiKey: must be a non-empty string');
  }
  if (!cfg.model || typeof cfg.model !== 'string') {
    errors.push('model: must be a non-empty string');
  }
  if (cfg.temperature != null && (typeof cfg.temperature !== 'number' || isNaN(cfg.temperature) || cfg.temperature < 0 || cfg.temperature > 2)) {
    errors.push('temperature: must be a number between 0 and 2');
  }
  return { valid: errors.length === 0, errors };
}

// ── Setup wizard (form-based) ─────────────────────────────────────────────────

const TIMESTAMPS_DISPLAY = { '': 'off', 'segment': 'segment', 'word': 'word', 'segment,word': 'both' };
const TIMESTAMPS_VALUE = { 'off': '', 'segment': 'segment', 'word': 'word', 'both': 'segment,word' };

async function setupWizard() {
  const existing = loadConfig() || {};

  const fields = [
    { key: 'apiKey', label: 'API key', type: 'secret', value: '', display: existing.apiKey ? '••••' + existing.apiKey.slice(-4) : '', fallback: existing.apiKey || '' },
    { key: 'model', label: 'Model', type: 'text', value: '', display: existing.model || 'voxtral-mini-latest', fallback: existing.model || 'voxtral-mini-latest' },
    { key: 'language', label: 'Language', type: 'text', value: '', display: existing.language || 'auto', fallback: existing.language || '' },
    { key: 'temperature', label: 'Temperature', type: 'text', value: '', display: existing.temperature != null ? String(existing.temperature) : 'default', fallback: existing.temperature != null ? String(existing.temperature) : '' },
    { key: 'contextBias', label: 'Context bias', type: 'text', value: '', display: existing.contextBias || '', fallback: existing.contextBias || '' },
    { key: 'timestamps', label: 'Timestamps', type: 'select', options: ['off', 'segment', 'word', 'both'], idx: ['off', 'segment', 'word', 'both'].indexOf(TIMESTAMPS_DISPLAY[existing.timestamps || ''] || 'off') },
    { key: 'diarize', label: 'Diarize', type: 'select', options: ['off', 'on'], idx: existing.diarize ? 1 : 0 },
  ];

  const LABEL_W = 15; // right-align labels to this width
  let active = 0;
  let editing = false; // true when typing into a text/secret field
  let inputBuf = '';

  function renderForm() {
    let out = `\x1b[H\x1b[2J`; // move home + clear screen
    out += `\n${BOLD} dikt — setup${RESET}\n`;

    // Contextual hint
    const f = fields[active];
    if (f.type === 'select') {
      out += `  ${DIM}Tab/arrows to change, Enter to confirm${RESET}\n`;
    } else if (editing) {
      out += `  ${DIM}Type to ${f.type === 'secret' ? 'enter' : 'change'}, Enter to confirm${RESET}\n`;
    } else {
      out += `  ${DIM}Enter to keep default, or start typing to change${RESET}\n`;
    }
    out += '\n';

    for (let i = 0; i < fields.length; i++) {
      const fi = fields[i];
      const label = fi.label.padStart(LABEL_W);
      const isActive = i === active;
      const marker = isActive ? `${GREEN}>${RESET}` : ' ';

      if (fi.type === 'select') {
        const parts = fi.options.map((opt, j) => {
          if (isActive) {
            return j === fi.idx ? `${BOLD}${GREEN}${opt}${RESET}` : `${DIM}${opt}${RESET}`;
          }
          return j === fi.idx ? opt : `${DIM}${opt}${RESET}`;
        });
        out += `${marker} ${isActive ? BOLD : DIM}${label}${RESET}  ${parts.join('   ')}\n`;
      } else {
        let valueStr;
        if (isActive && editing) {
          valueStr = fi.type === 'secret'
            ? `${GREEN}${'•'.repeat(inputBuf.length)}${RESET}█`
            : `${GREEN}${inputBuf}${RESET}█`;
        } else if (isActive && !editing) {
          valueStr = `${DIM}${fi.display}${RESET}`;
        } else {
          // Show confirmed value or default
          const show = fi.value || fi.display;
          valueStr = fi.value
            ? (fi.type === 'secret' ? '••••' + fi.value.slice(-4) : fi.value)
            : `${DIM}${show}${RESET}`;
        }
        out += `${marker} ${isActive ? BOLD : DIM}${label}${RESET}  ${valueStr}\n`;
      }
    }

    process.stderr.write(out);
  }

  return new Promise((resolve) => {
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    renderForm();

    function advance() {
      const f = fields[active];
      // Commit text/secret field value
      if (f.type !== 'select') {
        if (inputBuf.trim()) {
          f.value = inputBuf.trim();
        } else {
          f.value = f.fallback;
        }
        // Validate API key
        if (f.key === 'apiKey' && !f.value) {
          editing = false;
          inputBuf = '';
          renderForm();
          process.stderr.write(`\n  ${RED}API key is required.${RESET}\n`);
          return; // stay on this field
        }
        editing = false;
        inputBuf = '';
      }

      active++;
      if (active >= fields.length) {
        // Save and exit
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();

        const ts = fields.find(f => f.key === 'timestamps');
        const di = fields.find(f => f.key === 'diarize');
        const tsValue = TIMESTAMPS_VALUE[ts.options[ts.idx]];
        const diValue = di.options[di.idx] === 'on';

        const lang = fields.find(f => f.key === 'language').value;
        const tempVal = fields.find(f => f.key === 'temperature').value;

        const cfg = {
          apiKey: fields.find(f => f.key === 'apiKey').value,
          model: fields.find(f => f.key === 'model').value,
          language: lang === 'auto' ? '' : lang,
          temperature: tempVal && tempVal !== 'default' ? parseFloat(tempVal) : null,
          contextBias: fields.find(f => f.key === 'contextBias').value,
          autoCopy: existing.autoCopy || false,
          timestamps: tsValue,
          diarize: diValue,
        };
        saveConfig(cfg);
        process.stderr.write(`\n  ${GREEN}✓${RESET} Saved to ${DIM}${CONFIG_FILE}${RESET}\n\n`);
        resolve(cfg);
        return;
      }
      renderForm();
    }

    const onData = (ch) => {
      const f = fields[active];

      // Ctrl+C — exit
      if (ch === '\u0003') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write('\n');
        process.exit(EXIT_CONFIG);
      }

      if (f.type === 'select') {
        if (ch === '\t' || ch === '\x1b[C' || ch === '\x1b[B') { // Tab, Right, Down
          f.idx = (f.idx + 1) % f.options.length;
          renderForm();
        } else if (ch === '\x1b[D' || ch === '\x1b[A') { // Left, Up
          f.idx = (f.idx - 1 + f.options.length) % f.options.length;
          renderForm();
        } else if (ch === '\n' || ch === '\r') {
          advance();
        }
      } else {
        // text / secret field
        if (ch === '\n' || ch === '\r') {
          advance();
        } else if (ch === '\u007F' || ch === '\b') { // Backspace
          if (inputBuf.length > 0) {
            inputBuf = inputBuf.slice(0, -1);
            if (!inputBuf) editing = false;
            renderForm();
          }
        } else if (ch.charCodeAt(0) >= 32 && !ch.startsWith('\x1b')) {
          if (!editing) editing = true;
          inputBuf += ch;
          renderForm();
        }
      }
    };

    stdin.on('data', onData);
  });
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

function checkSox() {
  try {
    execFileSync('sox', ['--version'], { stdio: 'pipe' });
  } catch {
    process.stderr.write(`\n${RED}${BOLD}  sox not found.${RESET}\n\n`);
    process.stderr.write(`  dikt requires sox for audio recording. Install it:\n\n`);
    if (process.platform === 'darwin') {
      process.stderr.write(`    ${BOLD}brew install sox${RESET}\n\n`);
    } else if (process.platform === 'win32') {
      process.stderr.write(`    ${BOLD}choco install sox${RESET}  or  ${BOLD}scoop install sox${RESET}\n\n`);
    } else {
      process.stderr.write(`    ${BOLD}sudo apt install sox${RESET}  (Debian/Ubuntu)\n`);
      process.stderr.write(`    ${BOLD}sudo dnf install sox${RESET}  (Fedora)\n`);
      process.stderr.write(`    ${BOLD}sudo pacman -S sox${RESET}  (Arch)\n\n`);
    }
    process.exit(EXIT_DEPENDENCY);
  }
}

function checkTTY() {
  if (!process.stdin.isTTY) {
    process.stderr.write('dikt must run in a terminal (TTY).\n');
    process.exit(EXIT_NO_TTY);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  mode: 'idle',          // idle | recording | transcribing | ready | copied | help
  prevMode: '',
  transcript: '',
  wordCount: 0,
  duration: 0,           // recording duration in seconds
  latency: 0,            // transcription API time in ms
  error: '',
  history: [],           // [{transcript, wordCount, duration, latency}]
  historyIndex: -1,      // -1 = current, 0..n = browsing history
  recProc: null,
  recStart: 0,
  recFile: '',
  timerInterval: null,
  spinnerInterval: null,
  spinnerFrame: 0,
  copiedTimeout: null,
  lastCtrlC: 0,
};

// ── TUI Rendering ─────────────────────────────────────────────────────────────

let config = {};

function getTermWidth() {
  return process.stdout.columns || 60;
}

function render() {
  const w = getTermWidth();
  const header = ` dikt`;
  const tags = [];
  if (config.diarize) tags.push('diarize');
  if (config.timestamps) tags.push('timestamps');
  const tagStr = tags.length ? `  ${DIM}${tags.join(' · ')}${RESET}` : '';
  const tagPlain = tags.length ? `  ${tags.join(' · ')}` : '';
  const right = `[s]etup [?] [q]uit `;
  const pad = Math.max(0, w - header.length - tagPlain.length - right.length);

  let out = moveTo(1);

  if (state.mode === 'help') {
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + '\n';
    out += renderHelp();
  } else {
    out += CLEAR_LINE + BOLD + header + RESET + tagStr + ' '.repeat(pad) + DIM + right + RESET + '\n';
    out += CLEAR_LINE + ` ${'─'.repeat(Math.max(0, w - 2))}` + '\n';
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + renderKeybar() + '\n';
    out += CLEAR_LINE + '\n';
    out += CLEAR_LINE + renderStatus() + '\n';
    out += CLEAR_LINE + '\n';
  }

  if (state.mode !== 'help') {
    if (state.mode === 'idle' && !state.transcript) {
      out += CLEAR_LINE + `   ${DIM}Press SPACE to start dictating.${RESET}` + '\n';
      out += CLEAR_LINE + `   ${DIM}Press ? for all keybindings.${RESET}` + '\n';
    } else {
      let lines = wrapTranscript(w);
      // Cap transcript to available terminal rows to prevent overflow
      const rows = process.stdout.rows || 24;
      const availableRows = rows - 9; // header(2) + blank + keybar + blank + status + blank + meta + cleardown
      if (availableRows > 0 && lines.length > availableRows) {
        const hidden = lines.length - availableRows + 1; // +1 to make room for the hint
        lines = lines.slice(lines.length - availableRows + 1);
        lines.unshift(`   ${DIM}↑ ${hidden} more line${hidden === 1 ? '' : 's'} above${RESET}`);
      }
      for (const line of lines) {
        out += CLEAR_LINE + line + '\n';
      }
    }
  }

  if (state.mode !== 'help') out += CLEAR_LINE + renderMeta();
  out += CLEAR_DOWN;

  process.stdout.write(out);
}

function renderKeybar() {
  if (state.mode === 'recording') {
    return `   ${DIM}[SPACE]${RESET} Stop  ${DIM}[ESC]${RESET} Cancel`;
  }
  const copyKey = state.transcript && !config.autoCopy ? `${DIM}[c/↵]${RESET} Copy  ` : '';
  const autoCopyKey = config.autoCopy ? `${DIM}[a]${RESET} Auto-copy ✓  ` : `${DIM}[a]${RESET} Auto-copy  `;
  const histKey = state.history.length ? `${DIM}[h]${RESET} History  ` : '';
  const retryKey = state.recFile ? `${DIM}[r]${RESET} Retry  ` : '';
  return `   ${DIM}[SPACE]${RESET} Record  ${copyKey}${autoCopyKey}${histKey}${retryKey}`.trimEnd();
}

function renderStatus() {
  switch (state.mode) {
    case 'idle':
      return `   ${GREY}● Idle${RESET}`;
    case 'recording': {
      const secs = state.duration.toFixed(1);
      return `   ${RED}${BOLD}● Recording${RESET} ${RED}${secs}s${RESET}`;
    }
    case 'transcribing': {
      const sp = SPINNER[state.spinnerFrame % SPINNER.length];
      const hint = (Date.now() - state.lastCtrlC < 2000) ? `  ${DIM}Ctrl+C again to quit${RESET}` : '';
      return `   ${YELLOW}${sp} Transcribing...${RESET}${hint}`;
    }
    case 'ready':
      return `   ${GREEN}● Ready${RESET}`;
    case 'copied':
      return `   ${GREEN}${BOLD}● Copied!${RESET}`;
    case 'help':
      return `   ${GREY}? Help${RESET}`;
    case 'error':
      return `   ${RED}● ${state.error}${RESET}`;
    default:
      return `   ${GREY}● ${state.mode}${RESET}`;
  }
}

function wrapTranscript(termWidth) {
  const text = state.transcript;
  if (!text) return [];
  const indent = '   ';
  const maxLen = termWidth - indent.length - 1; // leave 1 col margin

  // Diarized transcript: each line is already formatted with speaker labels + ANSI colors.
  // Handle each speaker line independently — no quotes, just indent and wrap.
  if (config.diarize && text.includes('\n')) {
    const result = [];
    for (const speakerLine of text.split('\n')) {
      if (!speakerLine) continue;
      // ANSI codes mess up length calculation — strip them for measuring
      const plain = speakerLine.replace(/\x1b\[[0-9;]*m/g, '');
      if (plain.length <= maxLen || maxLen < 10) {
        result.push(`${indent}${speakerLine}`);
      } else {
        // Wrap long speaker lines: first line keeps the label, continuation lines get extra indent
        const labelMatch = plain.match(/^([A-Z]\s{2})/);
        const contIndent = labelMatch ? ' '.repeat(labelMatch[1].length) : '';
        const words = speakerLine.split(/(\s+)/);
        let cur = '';
        let curPlain = '';
        let first = true;
        for (const word of words) {
          const wordPlain = word.replace(/\x1b\[[0-9;]*m/g, '');
          if (curPlain.length + wordPlain.length > maxLen && curPlain.length > 0) {
            result.push(`${indent}${cur}`);
            cur = first ? contIndent : '';
            curPlain = first ? contIndent : '';
            first = false;
            const trimmed = word.replace(/^\s+/, '');
            cur += trimmed;
            curPlain += trimmed.replace(/\x1b\[[0-9;]*m/g, '');
          } else {
            cur += word;
            curPlain += wordPlain;
          }
        }
        if (cur) result.push(`${indent}${first ? '' : contIndent}${cur}`);
      }
    }
    return result;
  }

  if (maxLen < 10) return [`${indent}${text}`];

  const words = text.split(/(\s+)/);
  const lines = [];
  let cur = '';

  for (const word of words) {
    if (cur.length + word.length > maxLen && cur.length > 0) {
      lines.push(cur);
      cur = word.replace(/^\s+/, ''); // trim leading space on new line
    } else {
      cur += word;
    }
  }
  if (cur) lines.push(cur);

  return lines.map((line, i) => {
    if (i === 0 && lines.length === 1) return `${indent}${DIM}"${RESET}${line}${DIM}"${RESET}`;
    if (i === 0) return `${indent}${DIM}"${RESET}${line}`;
    if (i === lines.length - 1) return `${indent}${line}${DIM}"${RESET}`;
    return `${indent}${line}`;
  });
}

function renderMeta() {
  if (!state.transcript) return '';
  const cost = (state.duration / 60 * COST_PER_MIN).toFixed(4);
  const latencyStr = state.latency ? `${(state.latency / 1000).toFixed(1)}s` : '—';
  const histLabel = state.historyIndex >= 0 ? ` · history ${state.historyIndex + 1}/${state.history.length}` : '';
  return `   ${DIM}${state.wordCount} words · ${state.duration.toFixed(1)}s · latency ${latencyStr} · $${cost}${histLabel}${RESET}`;
}

function renderHelp() {
  let out = '';
  out += CLEAR_LINE + `   ${BOLD}Keybindings${RESET}` + '\n';
  out += CLEAR_LINE + '\n';
  out += CLEAR_LINE + `   ${BOLD}SPACE${RESET}      Start / stop recording` + '\n';
  out += CLEAR_LINE + `   ${BOLD}c${RESET}  ${BOLD}Enter${RESET}   Copy transcript to clipboard` + '\n';
  out += CLEAR_LINE + `   ${BOLD}a${RESET}          Toggle auto-copy to clipboard` + '\n';
  out += CLEAR_LINE + `   ${BOLD}h${RESET}          Cycle through history` + '\n';
  out += CLEAR_LINE + `   ${BOLD}r${RESET}          Re-transcribe last recording` + '\n';
  out += CLEAR_LINE + `   ${BOLD}Esc${RESET}        Cancel current recording` + '\n';
  out += CLEAR_LINE + `   ${BOLD}s${RESET}          Re-run setup wizard` + '\n';
  out += CLEAR_LINE + `   ${BOLD}?${RESET}          Show this help` + '\n';
  out += CLEAR_LINE + `   ${BOLD}q${RESET}          Quit  (also Ctrl+C)` + '\n';
  out += CLEAR_LINE + '\n';
  out += CLEAR_LINE + `   ${DIM}Press any key to return.${RESET}` + '\n';
  return out;
}

function renderStatusLine() {
  process.stdout.write(moveTo(6) + CLEAR_LINE + renderStatus());
  // Also update keybar since available keys change with state
  process.stdout.write(moveTo(4) + CLEAR_LINE + renderKeybar());
}

function renderAll() {
  render();
}

// ── Clipboard ─────────────────────────────────────────────────────────────────

let clipboardCmd = null;
let clipboardChecked = false;

function getClipboardCommand() {
  if (clipboardChecked) return clipboardCmd;
  clipboardChecked = true;

  if (process.platform === 'darwin') {
    clipboardCmd = ['pbcopy'];
    return clipboardCmd;
  }

  // Check for WSL
  try {
    const procVersion = fs.readFileSync('/proc/version', 'utf8');
    if (/microsoft/i.test(procVersion)) {
      clipboardCmd = ['clip.exe'];
      return clipboardCmd;
    }
  } catch {}

  // Linux/FreeBSD — try xclip, then xsel
  for (const cmd of [['xclip', '-selection', 'clipboard'], ['xsel', '--clipboard']]) {
    try {
      execFileSync('which', [cmd[0]], { stdio: 'pipe' });
      clipboardCmd = cmd;
      return clipboardCmd;
    } catch {}
  }

  return null;
}

function copy(text) {
  if (!text) return;

  const cmd = getClipboardCommand();
  if (!cmd) {
    state.mode = 'error';
    state.error = 'No clipboard tool found (install xclip)';
    renderAll();
    return;
  }

  const proc = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] });
  proc.on('error', () => {}); // swallow — clipboard is best-effort
  proc.stdin.end(text);

  state.mode = 'copied';
  renderAll();

  clearTimeout(state.copiedTimeout);
  state.copiedTimeout = setTimeout(() => {
    if (state.mode === 'copied') {
      state.mode = 'ready';
      renderAll();
    }
  }, 1500);
}

function toggleAutoCopy() {
  config.autoCopy = !config.autoCopy;
  saveConfig(config);
  renderAll();
}

// ── Recording ─────────────────────────────────────────────────────────────────

function startRecording() {
  state.error = '';
  state.transcript = '';
  state.wordCount = 0;
  state.latency = 0;

  // Clean up previous recording file
  if (state.recFile) {
    try { fs.unlinkSync(state.recFile); } catch {}
  }

  state.recFile = path.join(os.tmpdir(), `dikt-${Date.now()}.wav`);
  state.recStart = Date.now();
  state.duration = 0;
  state.mode = 'recording';
  state.historyIndex = -1;

  state.recProc = spawn('rec', ['-q', '-r', '16000', '-c', '1', '-b', '16', state.recFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let recStderr = '';
  state.recProc.stderr.on('data', (d) => { recStderr += d; });

  state.recProc.on('error', (err) => {
    state.mode = 'error';
    state.error = err.code === 'ENOENT' ? 'sox/rec not found' : err.message;
    state.recProc = null;
    clearInterval(state.timerInterval);
    renderAll();
  });

  state.recProc.on('close', (code) => {
    state.recProc = null;
    if (code && state.mode === 'recording') {
      clearInterval(state.timerInterval);
      state.mode = 'error';
      state.error = recStderr.trim().split('\n').pop() || `rec exited with code ${code}`;
      renderAll();
    }
  });

  state.timerInterval = setInterval(() => {
    state.duration = (Date.now() - state.recStart) / 1000;
    renderStatusLine();
  }, 200);

  renderAll();
}

function stopRecording() {
  if (!state.recProc) return;

  clearInterval(state.timerInterval);
  state.duration = (Date.now() - state.recStart) / 1000;

  const proc = state.recProc;
  state.recProc = null;

  if (state.duration * 1000 < MIN_RECORDING_MS) {
    proc.kill('SIGTERM');
    state.mode = 'error';
    state.error = 'Recording too short';
    renderAll();
    return;
  }

  // Wait for rec to finish writing the WAV file before transcribing
  state.mode = 'transcribing';
  state.spinnerFrame = 0;
  renderAll();

  proc.on('close', () => {
    transcribe(state.recFile);
  });
  proc.kill('SIGTERM');
}

function cancelRecording() {
  if (!state.recProc) return;

  clearInterval(state.timerInterval);
  state.recProc.kill('SIGTERM');
  state.recProc = null;

  // Clean up temp file
  if (state.recFile) {
    try { fs.unlinkSync(state.recFile); } catch {}
    state.recFile = '';
  }

  // Restore previous duration/latency from history if available
  if (state.history.length) {
    state.duration = state.history[0].duration;
    state.latency = state.history[0].latency;
  }

  state.mode = state.transcript ? 'ready' : 'idle';
  renderAll();
}

// ── Transcription ─────────────────────────────────────────────────────────────

async function transcribe(wavPath) {
  state.mode = 'transcribing';
  state.spinnerFrame = 0;
  renderAll();

  state.spinnerInterval = setInterval(() => {
    state.spinnerFrame++;
    renderStatusLine();
  }, 80);

  try {
    const blob = await fs.openAsBlob(wavPath, { type: 'audio/wav' });
    const file = new File([blob], 'recording.wav', { type: 'audio/wav' });

    const t0 = Date.now();
    const result = await callTranscribeAPI(file, {
      signal: AbortSignal.timeout(30_000),
      timestamps: config.timestamps || '',
      diarize: config.diarize || false,
    });
    state.latency = Date.now() - t0;

    const text = result.text;

    if (!text) {
      state.mode = 'error';
      state.error = 'No speech detected';
    } else {
      // Format with speaker labels if diarization is active
      if (config.diarize && result.segments) {
        state.transcript = formatDiarizedText(result.segments, { color: true });
      } else {
        state.transcript = text;
      }
      state.wordCount = text.split(/\s+/).filter(Boolean).length;
      state.mode = 'ready';

      // Push to history
      state.history.unshift({ transcript: state.transcript, wordCount: state.wordCount, duration: state.duration, latency: state.latency });
      if (state.history.length > MAX_HISTORY) state.history.pop();
      state.historyIndex = -1;
    }
  } catch (err) {
    state.mode = 'error';
    let msg = err.name === 'TimeoutError' ? 'Transcription timed out' : err.message;
    if (err.status === 401) msg += ' — press [s] to reconfigure';
    state.error = msg;
  } finally {
    clearInterval(state.spinnerInterval);
    cleanupRecFile();
    if (config.autoCopy && state.mode === 'ready') copy(state.transcript);
    renderAll();
  }
}

function cleanupRecFile() {
  // On success: delete the file (user got their transcript)
  // On error: keep the file so user can press [r] to retry
  if (state.mode !== 'error' && state.recFile) {
    try { fs.unlinkSync(state.recFile); } catch {}
    state.recFile = '';
  }
}

function cleanupTempFiles() {
  if (state.recFile) {
    try { fs.unlinkSync(state.recFile); } catch {}
  }
}

// ── History ───────────────────────────────────────────────────────────────────

function cycleHistory() {
  if (!state.history.length) return;

  state.historyIndex++;
  if (state.historyIndex >= state.history.length) {
    state.historyIndex = 0;
  }

  const entry = state.history[state.historyIndex];
  state.transcript = entry.transcript;
  state.wordCount = entry.wordCount;
  state.duration = entry.duration;
  state.latency = entry.latency;
  state.mode = 'ready';
  renderAll();
}

// ── Keypress Handler ──────────────────────────────────────────────────────────

function handleKey(str, key) {
  // Ctrl+C handling — double-press required during transcription
  if (key && key.ctrl && key.name === 'c') {
    if (state.mode === 'transcribing') {
      const now = Date.now();
      if (now - state.lastCtrlC < 2000) {
        quit();
        return;
      }
      state.lastCtrlC = now;
      renderStatusLine();
      return;
    }
    quit();
    return;
  }

  const ch = str || '';

  switch (state.mode) {
    case 'help':
      state.mode = state.prevMode || 'idle';
      state.prevMode = '';
      renderAll();
      break;

    case 'recording':
      if (ch === ' ') stopRecording();
      else if (key && key.name === 'escape') cancelRecording();
      else if (ch === 'q') quit();
      break;

    case 'transcribing':
      // Only quit allowed during transcription
      if (ch === 'q') quit();
      break;

    default: // idle, ready, copied, error
      if (ch === '?') {
        clearTimeout(state.copiedTimeout);
        state.prevMode = state.mode === 'copied' ? 'ready' : state.mode;
        state.mode = 'help';
        renderAll();
      }
      else if (ch === ' ') startRecording();
      else if (ch === 'c' || (key && key.name === 'return')) copy(state.transcript);
      else if (ch === 'a') toggleAutoCopy();
      else if (ch === 'h') cycleHistory();
      else if (ch === 'r' && state.recFile) retranscribe();
      else if (ch === 's') runSetup();
      else if (ch === 'q') quit();
      break;
  }
}

async function retranscribe() {
  if (!state.recFile) return;
  try {
    fs.accessSync(state.recFile);
  } catch {
    state.mode = 'error';
    state.error = 'Recording file no longer exists';
    renderAll();
    return;
  }
  transcribe(state.recFile);
}

async function runSetup() {
  // Temporarily exit raw mode and detach keypress handler for the setup wizard
  process.stdin.removeListener('keypress', handleKey);
  process.stdin.setRawMode(false);
  process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);

  config = await setupWizard();
  applyEnvOverrides(config);

  state.mode = state.transcript ? 'ready' : 'idle';
  state.error = '';

  process.stdin.resume();
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', handleKey);
  process.stdout.write(CLEAR_SCREEN + ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN);
  renderAll();
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

const SILENCE_THRESHOLD = Math.round(32768 * 0.01); // 1% of max 16-bit amplitude

function createWavHeader(dataSize) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);         // PCM
  buf.writeUInt16LE(1, 22);         // mono
  buf.writeUInt32LE(16000, 24);     // sample rate
  buf.writeUInt32LE(32000, 28);     // byte rate (16000 * 1 * 2)
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function peakAmplitude(chunk) {
  let peak = 0;
  for (let i = 0; i < chunk.length - 1; i += 2) {
    const abs = Math.abs(chunk.readInt16LE(i));
    if (abs > peak) peak = abs;
  }
  return peak;
}

function trimSilence(rawData) {
  const SAMPLE_RATE = 16000;
  const BYTES_PER_SAMPLE = 2;
  const WINDOW_SAMPLES = Math.round(SAMPLE_RATE * 0.05); // 50ms windows
  const WINDOW_BYTES = WINDOW_SAMPLES * BYTES_PER_SAMPLE;
  const MAX_SILENCE_WINDOWS = Math.round(1.0 / 0.05); // 1 second = 20 windows
  const PAD_WINDOWS = Math.round(0.1 / 0.05); // 100ms padding = 2 windows

  const windows = [];
  for (let offset = 0; offset + WINDOW_BYTES <= rawData.length; offset += WINDOW_BYTES) {
    windows.push(rawData.subarray(offset, offset + WINDOW_BYTES));
  }
  // Include any trailing partial window
  const remainder = rawData.length % WINDOW_BYTES;
  if (remainder > 0) {
    windows.push(rawData.subarray(rawData.length - remainder));
  }

  const output = [];
  let silentCount = 0;

  for (const win of windows) {
    const peak = peakAmplitude(win);
    if (peak < SILENCE_THRESHOLD) {
      silentCount++;
      if (silentCount <= MAX_SILENCE_WINDOWS) {
        output.push(win);
      } else if (silentCount === MAX_SILENCE_WINDOWS + 1) {
        // Replace excess silence with padding
        const padBytes = PAD_WINDOWS * WINDOW_BYTES;
        output.push(Buffer.alloc(padBytes)); // zeros = silence
      }
      // else: skip (already added padding)
    } else {
      silentCount = 0;
      output.push(win);
    }
  }

  return Buffer.concat(output);
}

async function callTranscribeAPI(file, { signal, timestamps, diarize } = {}) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('model', config.model);
  if (config.language) fd.append('language', config.language);
  if (config.temperature != null) fd.append('temperature', String(config.temperature));
  if (config.contextBias) fd.append('context_bias', config.contextBias);
  if (timestamps) {
    for (const g of timestamps.split(',')) fd.append('timestamp_granularities[]', g.trim());
  }
  if (diarize) {
    fd.append('diarize', 'true');
    // API requires segment timestamps when diarize is enabled
    if (!timestamps) fd.append('timestamp_granularities[]', 'segment');
  }

  const t0 = Date.now();
  const resp = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: fd,
    signal: signal || AbortSignal.timeout(30_000),
  });
  const latency = Date.now() - t0;

  if (!resp.ok) {
    const raw = await resp.text().catch(() => '');
    let msg;
    try {
      const e = JSON.parse(raw);
      msg = e.message;
      if (typeof msg === 'object' && msg !== null) msg = JSON.stringify(msg);
      if (!msg && Array.isArray(e.detail)) {
        msg = e.detail.map(d => [d.loc?.join('.'), d.msg].filter(Boolean).join(': ')).join('; ');
      } else if (!msg && e.detail) {
        msg = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
      }
      if (!msg) msg = raw;
    } catch {
      msg = raw || `HTTP ${resp.status}`;
    }
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }

  const data = await resp.json();
  const text = (data.text || '').trim();
  return { text, latency, segments: data.segments, words: data.words };
}

async function transcribeBuffer(rawChunks, { signal, timestamps, diarize } = {}) {
  const rawData = Buffer.concat(rawChunks);
  const trimmed = trimSilence(rawData);
  const wavData = Buffer.concat([createWavHeader(trimmed.length), trimmed]);
  const blob = new Blob([wavData], { type: 'audio/wav' });
  const file = new File([blob], 'recording.wav', { type: 'audio/wav' });
  return callTranscribeAPI(file, { signal, timestamps, diarize });
}

// ── Output formatting helpers ─────────────────────────────────────────────────

const SPEAKER_COLORS = [GREEN, YELLOW, CYAN, MAGENTA, BLUE, RED];

function formatDiarizedText(segments, { color = false } = {}) {
  if (!segments || !segments.length) return '';

  // Map speaker IDs to short letters (A, B, C, ...)
  const speakerMap = new Map();
  for (const s of segments) {
    if (s.speaker_id != null && !speakerMap.has(s.speaker_id)) {
      speakerMap.set(s.speaker_id, speakerMap.size);
    }
  }

  // Merge consecutive segments from the same speaker
  const merged = [];
  for (const s of segments) {
    const text = (s.text || '').trim();
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.speaker_id === s.speaker_id) {
      last.text += ' ' + text;
    } else {
      merged.push({ speaker_id: s.speaker_id, text });
    }
  }

  return merged.map(s => {
    const idx = speakerMap.get(s.speaker_id) ?? 0;
    const letter = String.fromCharCode(65 + idx); // A, B, C, ...
    if (color) {
      const c = SPEAKER_COLORS[idx % SPEAKER_COLORS.length];
      return `${c}${BOLD}${letter}${RESET}  ${s.text}`;
    }
    return `${letter}  ${s.text}`;
  }).join('\n');
}

function buildJsonOutput(base, { segments, words, timestamps, diarize } = {}) {
  const out = { ...base, timestamp: new Date().toISOString() };
  if ((timestamps || diarize) && segments) out.segments = segments;
  if (timestamps && words) out.words = words;
  return out;
}

// ── File mode ────────────────────────────────────────────────────────────────

async function runFile(flags) {
  try {
    if (!flags.file || !fs.existsSync(flags.file)) {
      process.stderr.write(`Error: file not found: ${flags.file}\n`);
      return EXIT_TRANSCRIPTION;
    }

    const blob = await fs.openAsBlob(flags.file);
    const ext = path.extname(flags.file).slice(1) || 'wav';
    const mimeTypes = { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm' };
    const mime = mimeTypes[ext] || 'audio/wav';
    const file = new File([blob], path.basename(flags.file), { type: mime });

    const ac = new AbortController();
    const abortHandler = () => ac.abort();
    process.on('SIGINT', abortHandler);

    const result = await callTranscribeAPI(file, { signal: ac.signal, timestamps: flags.timestamps, diarize: flags.diarize });
    process.removeListener('SIGINT', abortHandler);

    if (!result.text) {
      process.stderr.write('No speech detected\n');
      return EXIT_TRANSCRIPTION;
    }

    const wordCount = result.text.split(/\s+/).filter(Boolean).length;

    let output;
    if (flags.json) {
      const out = buildJsonOutput(
        { text: result.text, latency: result.latency, words: wordCount },
        { segments: result.segments, words: result.words, timestamps: flags.timestamps, diarize: flags.diarize },
      );
      output = JSON.stringify(out, null, flags.output ? 2 : 0) + '\n';
    } else if (flags.diarize && result.segments) {
      output = formatDiarizedText(result.segments) + '\n';
    } else {
      output = result.text + '\n';
    }

    if (flags.output) {
      fs.writeFileSync(flags.output, output);
      process.stderr.write(`Saved to ${flags.output}\n`);
    } else {
      process.stdout.write(output);
    }

    return EXIT_OK;
  } catch (err) {
    if (err.name === 'AbortError') {
      process.stderr.write('Aborted\n');
      return EXIT_TRANSCRIPTION;
    }
    process.stderr.write(`Error: ${err.message}\n`);
    return EXIT_TRANSCRIPTION;
  }
}

// ── Single-shot mode ──────────────────────────────────────────────────────────

async function runOnce(flags) {
  try {
    // Record raw PCM to stdout — silence detection handled in Node.js
    const recProc = spawn('rec', [
      '-q', '-r', '16000', '-c', '1', '-b', '16', '-t', 'raw', '-',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    recProc.stderr.on('data', () => {});

    const sigHandler = () => recProc.kill('SIGTERM');
    process.on('SIGINT', sigHandler);

    const chunks = [];
    let heardSound = false;
    let lastSoundTime = Date.now();
    const recStart = Date.now();

    recProc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      if (peakAmplitude(chunk) > SILENCE_THRESHOLD) {
        heardSound = true;
        lastSoundTime = Date.now();
      }
    });

    const silenceTimer = setInterval(() => {
      if (flags.silence > 0 && heardSound && Date.now() - lastSoundTime > flags.silence * 1000) {
        recProc.kill('SIGTERM');
      }
    }, 100);

    await new Promise((resolve) => recProc.on('close', resolve));
    clearInterval(silenceTimer);
    process.removeListener('SIGINT', sigHandler);
    const duration = (Date.now() - recStart) / 1000;

    if (duration < MIN_RECORDING_MS / 1000) {
      process.stderr.write('Recording too short\n');
      return EXIT_TRANSCRIPTION;
    }

    // Transcribe — Ctrl+C during this aborts the request
    const ac = new AbortController();
    const abortHandler = () => ac.abort();
    process.on('SIGINT', abortHandler);

    const result = await transcribeBuffer(chunks, { signal: ac.signal, timestamps: flags.timestamps, diarize: flags.diarize });
    process.removeListener('SIGINT', abortHandler);

    if (!result.text) {
      process.stderr.write('No speech detected\n');
      return EXIT_TRANSCRIPTION;
    }

    const wordCount = result.text.split(/\s+/).filter(Boolean).length;

    let output;
    if (flags.json) {
      const out = buildJsonOutput(
        { text: result.text, duration: parseFloat(duration.toFixed(1)), latency: result.latency, words: wordCount },
        { segments: result.segments, words: result.words, timestamps: flags.timestamps, diarize: flags.diarize },
      );
      output = JSON.stringify(out, null, flags.output ? 2 : 0) + '\n';
    } else if (flags.diarize && result.segments) {
      output = formatDiarizedText(result.segments) + '\n';
    } else {
      output = result.text + '\n';
    }

    if (flags.output) {
      fs.writeFileSync(flags.output, output);
      process.stderr.write(`Saved to ${flags.output}\n`);
    } else {
      process.stdout.write(output);
    }

    return EXIT_OK;
  } catch (err) {
    if (err.name === 'AbortError') {
      process.stderr.write('Aborted\n');
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    return EXIT_TRANSCRIPTION;
  }
}

// ── Stream mode ──────────────────────────────────────────────────────────────

async function runStream(flags) {
  try {
    const recProc = spawn('rec', [
      '-q', '-r', '16000', '-c', '1', '-b', '16', '-t', 'raw', '-',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    recProc.stderr.on('data', () => {});

    let killed = false;
    const killRec = () => { if (!killed) { killed = true; recProc.kill('SIGTERM'); process.stderr.write('\n'); } };
    process.on('SIGINT', killRec);

    let chunks = [];          // current chunk buffer (resets per pause)
    let chunkHasAudio = false; // current chunk has sound (resets per pause)
    let heardSound = false;    // ever heard sound (never resets)
    let lastSoundTime = Date.now();
    let chunkStart = Date.now();
    let chunkIndex = 0;
    const pending = [];
    const outputParts = [];    // collect output for --output

    recProc.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      if (peakAmplitude(chunk) > SILENCE_THRESHOLD) {
        chunkHasAudio = true;
        heardSound = true;
        lastSoundTime = Date.now();
      }
    });

    const checkTimer = setInterval(() => {
      const silenceMs = Date.now() - lastSoundTime;

      // Pause: send current chunk for transcription, keep recording
      if (chunkHasAudio && silenceMs > flags.pause * 1000 && chunks.length > 0) {
        const batch = chunks;
        const duration = (Date.now() - chunkStart) / 1000;
        const idx = chunkIndex++;
        chunks = [];
        chunkHasAudio = false;
        chunkStart = Date.now();

        const p = transcribeBuffer(batch, { timestamps: flags.timestamps, diarize: flags.diarize })
          .then((result) => {
            if (!result.text) return;
            const wordCount = result.text.split(/\s+/).filter(Boolean).length;
            let chunk_output;
            if (flags.json) {
              const out = buildJsonOutput(
                { text: result.text, chunk: idx, duration: parseFloat(duration.toFixed(1)), latency: result.latency, words: wordCount },
                { segments: result.segments, words: result.words, timestamps: flags.timestamps, diarize: flags.diarize },
              );
              chunk_output = JSON.stringify(out, null, flags.output ? 2 : 0) + '\n';
            } else if (flags.diarize && result.segments) {
              const sep = flags.noNewline ? ' ' : '\n';
              chunk_output = formatDiarizedText(result.segments) + sep;
            } else {
              chunk_output = result.text + (flags.noNewline ? ' ' : '\n');
            }
            if (flags.output) {
              outputParts[idx] = chunk_output;
            } else {
              process.stdout.write(chunk_output);
            }
          })
          .catch((err) => {
            process.stderr.write(`Chunk ${idx} error: ${err.message}\n`);
          });
        pending.push(p);
      }

      // Stop: full silence threshold reached
      if (flags.silence > 0 && heardSound && silenceMs > flags.silence * 1000) {
        killRec();
      }
    }, 100);

    await new Promise((resolve) => recProc.on('close', resolve));
    clearInterval(checkTimer);
    process.removeListener('SIGINT', killRec);

    // Send any remaining audio that hasn't been sent yet
    if (chunks.length > 0 && chunkHasAudio) {
      const duration = (Date.now() - chunkStart) / 1000;
      const idx = chunkIndex++;
      try {
        const result = await transcribeBuffer(chunks, { timestamps: flags.timestamps, diarize: flags.diarize });
        if (result.text) {
          const wordCount = result.text.split(/\s+/).filter(Boolean).length;
          let chunk_output;
          if (flags.json) {
            const out = buildJsonOutput(
              { text: result.text, chunk: idx, duration: parseFloat(duration.toFixed(1)), latency: result.latency, words: wordCount },
              { segments: result.segments, words: result.words, timestamps: flags.timestamps, diarize: flags.diarize },
            );
            chunk_output = JSON.stringify(out, null, flags.output ? 2 : 0) + '\n';
          } else if (flags.diarize && result.segments) {
            const sep = flags.noNewline ? ' ' : '\n';
            chunk_output = formatDiarizedText(result.segments) + sep;
          } else {
            chunk_output = result.text + (flags.noNewline ? ' ' : '\n');
          }
          if (flags.output) {
            outputParts[idx] = chunk_output;
          } else {
            process.stdout.write(chunk_output);
          }
        }
      } catch (err) {
        process.stderr.write(`Chunk ${idx} error: ${err.message}\n`);
      }
    }

    // Wait for any in-flight transcriptions to finish
    await Promise.allSettled(pending);

    if (flags.output && outputParts.length) {
      fs.writeFileSync(flags.output, outputParts.filter(Boolean).join(''));
      process.stderr.write(`Saved to ${flags.output}\n`);
    }

    // Final newline for --no-newline so shell prompt starts on a new line
    if (!flags.output && flags.noNewline && !flags.json) process.stdout.write('\n');

    return EXIT_OK;
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    return EXIT_TRANSCRIPTION;
  }
}

// ── Graceful Exit ─────────────────────────────────────────────────────────────

function quit() {
  clearInterval(state.timerInterval);
  clearInterval(state.spinnerInterval);
  clearTimeout(state.copiedTimeout);

  if (state.recProc) {
    state.recProc.kill('SIGTERM');
  }

  cleanupTempFiles();

  process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  process.stdin.setRawMode(false);
  process.exit(EXIT_OK);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function flagVal(args, name, hint, { valid, numeric } = {}) {
  const i = args.indexOf(name);
  if (i === -1) return '';
  const v = args[i + 1];
  if (!v || v.startsWith('-')) {
    const h = hint ? ` (${hint})` : '';
    process.stderr.write(`Error: ${name} requires a value${h}\n`);
    process.exit(EXIT_CONFIG);
  }
  if (valid && !valid.includes(v)) {
    process.stderr.write(`Error: invalid value for ${name}: '${v}' (${hint})\n`);
    process.exit(EXIT_CONFIG);
  }
  if (numeric && !Number.isFinite(parseFloat(v))) {
    process.stderr.write(`Error: ${name} must be a number\n`);
    process.exit(EXIT_CONFIG);
  }
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    json: args.includes('--json'),
    quiet: args.includes('--quiet') || args.includes('-q'),
    noInput: args.includes('--no-input'),
    setup: args.includes('--setup') || args[0] === 'setup',
    stream: args.includes('--stream'),
    silence: args.includes('--silence') ? parseFloat(flagVal(args, '--silence', 'seconds', { numeric: true })) : 2.0,
    pause: args.includes('--pause') ? parseFloat(flagVal(args, '--pause', 'seconds', { numeric: true })) : 1.0,
    language: flagVal(args, '--language', 'e.g. en, de, fr'),
    file: flagVal(args, '--file', 'path to audio file'),
    noNewline: args.includes('--no-newline') || args.includes('-n'),
    timestamps: flagVal(args, '--timestamps', 'segment, word, or segment,word', { valid: ['segment', 'word', 'segment,word'] }),
    diarize: args.includes('--diarize'),
    output: flagVal(args, '--output', 'path') || flagVal(args, '-o', 'path'),
  };

  if (args.includes('--version')) {
    console.log(`dikt v${VERSION}`);
    process.exit(EXIT_OK);
  }

  if (args.includes('--update') || args[0] === 'update') {
    try {
      const resp = await fetch('https://registry.npmjs.org/dikt/latest');
      const data = await resp.json();
      const latest = data.version;
      if (latest === VERSION) {
        console.log(`dikt v${VERSION} is already up to date.`);
        process.exit(EXIT_OK);
      }
      console.log(`Updating dikt v${VERSION} → v${latest}...`);
      execFileSync('npm', ['install', '-g', 'dikt@latest'], { stdio: 'inherit' });
      console.log(`Updated to dikt v${latest}.`);
    } catch (err) {
      console.error(`Update failed: ${err.message}`);
      process.exit(EXIT_DEPENDENCY);
    }
    process.exit(EXIT_OK);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`dikt v${VERSION} — voice dictation for the terminal

Usage: dikt [options] [command]

Commands:
  setup                      Reconfigure API key and model
  update                     Update dikt to the latest version

Options:
  --setup                    Run setup wizard
  --update                   Update to latest version
  --json                     Record once, output JSON to stdout
  -q, --quiet                Record once, print transcript to stdout
  --stream                   Stream transcription chunks on pauses
  --file <path>              Transcribe an audio file (no mic needed)
  -o, --output <path>        Write output to file (.json auto-enables JSON)
  --silence <seconds>        Silence duration before auto-stop (default: 2.0)
  --pause <seconds>          Pause duration to split chunks (default: 1.0)
  --language <code>          Language code, e.g. en, de, fr (default: auto)
  -n, --no-newline           Join stream chunks without newlines
  --timestamps <granularity> Add timestamps: segment, word, or segment,word
  --diarize                  Enable speaker identification
  --no-input                 Fail if config is missing (no wizard)
  --no-color                 Disable colored output
  --version                  Show version
  -h, --help                 Show this help

Keys (interactive mode):
  SPACE   Start/stop recording     c / Enter   Copy to clipboard
  a       Toggle auto-copy         h           Cycle history
  r       Re-transcribe            Esc         Cancel recording
  s       Re-run setup             ?           Show keybindings
  q       Quit  (also Ctrl+C)

Examples:
  dikt                       Start interactive dictation
  dikt setup                 Reconfigure API key and model
  dikt -q                    Record once, print transcript to stdout
  dikt --json                Record once, output JSON to stdout
  dikt -q --silence 5        Wait longer before auto-stopping
  dikt --stream              Stream chunks as you speak
  dikt --stream --json       Stream chunks as JSON Lines
  dikt -q | claude           Dictate a prompt to Claude Code
  dikt update                Update to the latest version
  dikt --file meeting.wav    Transcribe an existing audio file
  dikt --file a.wav -o a.json  Transcribe to a JSON file
  dikt --file a.wav -o a.txt   Transcribe to a text file
  dikt --stream --silence 0  Stream continuously until Ctrl+C
  dikt --stream -n           Stream as continuous flowing text
  dikt -q --json --diarize   Transcribe with speaker labels

Environment variables:
  DIKT_API_KEY               Override API key from config
  DIKT_MODEL                 Override model (default: voxtral-mini-latest)
  DIKT_LANGUAGE              Override language (default: auto)
  DIKT_TEMPERATURE           Override temperature
  DIKT_CONTEXT_BIAS          Override context bias

Exit codes:
  0  Success
  1  Missing dependency (sox)
  2  Not a terminal
  3  Configuration error
  4  Transcription error

Config: ${CONFIG_DIR}/config.json
Requires: sox (brew install sox)`);
    process.exit(EXIT_OK);
  }

  // Load or setup config
  if (flags.setup) {
    checkTTY();
    config = await setupWizard();
  } else {
    config = loadConfig();
    if (!config) {
      if (flags.noInput) {
        process.stderr.write('No config found. Run `dikt setup` to configure.\n');
        process.exit(EXIT_CONFIG);
      }
      checkTTY();
      config = await setupWizard();
    }
  }

  applyEnvOverrides(config);
  if (flags.language) config.language = flags.language;
  if (!flags.timestamps && config.timestamps) flags.timestamps = config.timestamps;
  if (!flags.diarize && config.diarize) flags.diarize = true;
  if (flags.output && flags.output.endsWith('.json')) flags.json = true;

  const validation = validateConfig(config);
  if (!validation.valid) {
    for (const err of validation.errors) {
      process.stderr.write(`Config error: ${err}\n`);
    }
    process.exit(EXIT_CONFIG);
  }

  // Validate incompatible flag combinations
  // Only error when both sides are CLI-passed. When one comes from config,
  // let the explicit CLI flag win and silently drop the config value.
  const cliLanguage = args.includes('--language');
  const cliTimestamps = args.includes('--timestamps');
  const cliDiarize = args.includes('--diarize');
  const lang = config.language;
  if (lang && flags.timestamps) {
    if (cliLanguage && cliTimestamps) {
      process.stderr.write('Error: --timestamps and --language cannot be used together\n');
      process.exit(EXIT_CONFIG);
    }
    if (cliLanguage) flags.timestamps = '';
    else config.language = '';
  }
  if (lang && flags.diarize) {
    if (cliLanguage && cliDiarize) {
      process.stderr.write('Error: --diarize and --language cannot be used together\n');
      process.exit(EXIT_CONFIG);
    }
    if (cliLanguage) flags.diarize = false;
    else config.language = '';
  }
  if (flags.diarize && flags.stream) {
    process.stderr.write('Error: --diarize is not compatible with --stream, use -q --diarize instead\n');
    process.exit(EXIT_CONFIG);
  }

  // File mode: transcribe an existing audio file (no sox needed)
  if (flags.file) {
    process.exit(await runFile(flags));
  }

  checkSox();

  // Stream mode: chunked transcription on pauses
  if (flags.stream) {
    process.exit(await runStream(flags));
  }

  // Single-shot mode: record once, output, exit
  if (flags.json || flags.quiet) {
    process.exit(await runOnce(flags));
  }

  // Warn about flags that don't apply to interactive mode
  if (flags.output) {
    process.stderr.write(`Warning: --output is ignored in interactive mode. Use with --file, -q, or --stream.\n`);
  }

  // Interactive TUI mode
  checkTTY();

  // Clear any setup wizard output before entering alt screen, so it doesn't
  // leak back when the alt screen exits.
  process.stdout.write(CLEAR_SCREEN);

  // Enter raw TUI mode (alternate screen buffer prevents scrollback corruption)
  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR_SCREEN);

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', handleKey);

  // Handle resize
  process.stdout.on('resize', () => renderAll());

  // Handle signals
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  renderAll();
}

main().catch((err) => {
  if (process.stdout.isTTY) process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  console.error(err);
  process.exit(EXIT_DEPENDENCY);
});
