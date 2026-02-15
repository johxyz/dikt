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
let GREY = `${ESC}90m`;
let WHITE = `${ESC}37m`;
let RED_BG = `${ESC}41m`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}2K`;
const CLEAR_DOWN = `${ESC}J`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

if (process.env.NO_COLOR != null || process.env.TERM === 'dumb' || process.argv.includes('--no-color')) {
  RESET = BOLD = DIM = RED = GREEN = YELLOW = GREY = WHITE = RED_BG = '';
}

const moveTo = (row, col = 1) => `${ESC}${row};${col}H`;

// ── Constants ─────────────────────────────────────────────────────────────────

const VERSION = '1.0.0';
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

// ── Secret input ──────────────────────────────────────────────────────────────

function readSecret(prompt) {
  return new Promise((resolve) => {
    process.stderr.write(prompt);
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let secret = '';

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onData = (ch) => {
      switch (ch) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          cleanup();
          process.stderr.write('\n');
          resolve(secret);
          break;
        case '\u0003': // Ctrl+C
          cleanup();
          process.stderr.write('\n');
          process.exit(EXIT_CONFIG);
          break;
        case '\u007F': // Backspace (macOS)
        case '\b':     // Backspace
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            process.stderr.write('\b \b');
          }
          break;
        default:
          if (ch.charCodeAt(0) >= 32) {
            secret += ch;
            process.stderr.write('*');
          }
          break;
      }
    };

    stdin.on('data', onData);
  });
}

// ── Setup wizard ──────────────────────────────────────────────────────────────

async function setupWizard() {
  const existing = loadConfig() || {};

  process.stderr.write(`\n${BOLD} dikt — setup${RESET}\n`);
  process.stderr.write(`  ${DIM}Press Enter to keep the default shown in brackets.${RESET}\n\n`);

  const apiKey = (await readSecret(`  Mistral API key [${existing.apiKey ? '••••' + existing.apiKey.slice(-4) : ''}]: `)).trim()
    || existing.apiKey || '';
  if (!apiKey) {
    process.stderr.write(`\n  ${RED}API key is required.${RESET}\n\n`);
    process.exit(EXIT_CONFIG);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const model = (await ask(`  Model [${existing.model || 'voxtral-mini-latest'}]: `)).trim()
    || existing.model || 'voxtral-mini-latest';
  const language = (await ask(`  Language [${existing.language || 'auto'}]: `)).trim()
    || existing.language || '';
  const tempStr = (await ask(`  Temperature [${existing.temperature ?? 'default'}]: `)).trim();
  const temperature = tempStr ? parseFloat(tempStr) : (existing.temperature ?? null);
  const contextBias = (await ask(`  Context bias [${existing.contextBias || ''}]: `)).trim()
    || existing.contextBias || '';

  rl.close();

  const cfg = { apiKey, model, language: language === 'auto' ? '' : language, temperature, contextBias, autoCopy: existing.autoCopy || false };
  saveConfig(cfg);
  process.stderr.write(`\n  ${GREEN}✓${RESET} Saved to ${DIM}${CONFIG_FILE}${RESET}\n\n`);
  return cfg;
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

function checkSox() {
  try {
    execFileSync('sox', ['--version'], { stdio: 'pipe' });
  } catch {
    process.stderr.write(`\n${RED}${BOLD}  sox not found.${RESET}\n`);
    process.stderr.write(`  Install it with: ${BOLD}brew install sox${RESET}\n\n`);
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
  const right = `[?] [q]uit `;
  const pad = Math.max(0, w - header.length - right.length);

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
    out += CLEAR_LINE + BOLD + header + ' '.repeat(pad) + DIM + right + RESET + '\n';
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
      const lines = wrapTranscript(w);
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

  state.recProc.stderr.on('data', () => {}); // suppress sox warnings

  state.recProc.on('error', (err) => {
    state.mode = 'error';
    state.error = err.code === 'ENOENT' ? 'sox/rec not found' : err.message;
    state.recProc = null;
    clearInterval(state.timerInterval);
    renderAll();
  });

  state.recProc.on('close', () => {
    state.recProc = null;
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
    const fd = new FormData();
    fd.append('file', file);
    fd.append('model', config.model);
    if (config.language) fd.append('language', config.language);
    if (config.temperature != null) fd.append('temperature', String(config.temperature));
    if (config.contextBias) fd.append('context_bias', config.contextBias);

    const t0 = Date.now();
    const resp = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    state.latency = Date.now() - t0;

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      let msg;
      try {
        const e = JSON.parse(raw);
        msg = e.message;
        if (!msg && Array.isArray(e.detail)) {
          msg = e.detail.map(d => [d.loc?.join('.'), d.msg].filter(Boolean).join(': ')).join('; ');
        } else if (!msg && e.detail) {
          msg = typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail);
        }
        if (!msg) msg = raw;
      } catch {
        msg = raw || `HTTP ${resp.status}`;
      }
      if (resp.status === 401) msg += ' — press [s] to reconfigure';
      throw new Error(msg);
    }

    const data = await resp.json();
    const text = (data.text || '').trim();

    if (!text) {
      state.mode = 'error';
      state.error = 'No speech detected';
    } else {
      state.transcript = text;
      state.wordCount = text.split(/\s+/).filter(Boolean).length;
      state.mode = 'ready';

      // Push to history
      state.history.unshift({ transcript: text, wordCount: state.wordCount, duration: state.duration, latency: state.latency });
      if (state.history.length > MAX_HISTORY) state.history.pop();
      state.historyIndex = -1;
    }
  } catch (err) {
    state.mode = 'error';
    state.error = err.name === 'TimeoutError' ? 'Transcription timed out' : err.message;
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
  process.stdout.write(SHOW_CURSOR + CLEAR_SCREEN);

  config = await setupWizard();
  applyEnvOverrides(config);

  process.stdin.resume();
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', handleKey);
  process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN);
  renderAll();
}

// ── Single-shot mode ──────────────────────────────────────────────────────────

async function runOnce(flags) {
  const recFile = path.join(os.tmpdir(), `dikt-${Date.now()}.wav`);

  try {
    // Record with silence detection via sox silence effect
    const recProc = spawn('rec', [
      '-q', '-r', '16000', '-c', '1', '-b', '16',
      recFile,
      'silence', '1', '0.1', '1%', '1', '2.0', '1%',
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    recProc.stderr.on('data', () => {});

    // Ctrl+C stops recording gracefully
    const sigHandler = () => recProc.kill('SIGTERM');
    process.on('SIGINT', sigHandler);

    const recStart = Date.now();
    await new Promise((resolve) => recProc.on('close', resolve));
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

    const blob = await fs.openAsBlob(recFile, { type: 'audio/wav' });
    const file = new File([blob], 'recording.wav', { type: 'audio/wav' });
    const fd = new FormData();
    fd.append('file', file);
    fd.append('model', config.model);
    if (config.language) fd.append('language', config.language);
    if (config.temperature != null) fd.append('temperature', String(config.temperature));
    if (config.contextBias) fd.append('context_bias', config.contextBias);

    const t0 = Date.now();
    const resp = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: fd,
      signal: ac.signal,
    });
    const latency = Date.now() - t0;
    process.removeListener('SIGINT', abortHandler);

    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      process.stderr.write(`Error: ${raw || `HTTP ${resp.status}`}\n`);
      return EXIT_TRANSCRIPTION;
    }

    const data = await resp.json();
    const text = (data.text || '').trim();

    if (!text) {
      process.stderr.write('No speech detected\n');
      return EXIT_TRANSCRIPTION;
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;

    if (flags.json) {
      process.stdout.write(JSON.stringify({ text, duration: parseFloat(duration.toFixed(1)), latency, words: wordCount }) + '\n');
    } else {
      process.stdout.write(text + '\n');
    }

    return EXIT_OK;
  } catch (err) {
    if (err.name === 'AbortError') {
      process.stderr.write('Aborted\n');
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
    return EXIT_TRANSCRIPTION;
  } finally {
    try { fs.unlinkSync(recFile); } catch {}
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

  const h = process.stdout.rows || 24;
  process.stdout.write(SHOW_CURSOR + moveTo(h) + '\n');
  process.stdin.setRawMode(false);
  process.exit(EXIT_OK);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = {
    json: args.includes('--json'),
    quiet: args.includes('--quiet') || args.includes('-q'),
    noInput: args.includes('--no-input'),
    setup: args.includes('--setup') || args[0] === 'setup',
  };

  if (args.includes('--version')) {
    console.log(`dikt v${VERSION}`);
    process.exit(EXIT_OK);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`dikt v${VERSION} — voice dictation for the terminal

Usage: dikt [options] [command]

Commands:
  setup                      Reconfigure API key and model

Options:
  --setup                    Run setup wizard
  --json                     Record once, output JSON to stdout
  -q, --quiet                Record once, print transcript to stdout
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
  dikt -q | claude           Dictate a prompt to Claude Code

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

  checkSox();

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

  const validation = validateConfig(config);
  if (!validation.valid) {
    for (const err of validation.errors) {
      process.stderr.write(`Config error: ${err}\n`);
    }
    process.exit(EXIT_CONFIG);
  }

  // Single-shot mode: record once, output, exit
  if (flags.json || flags.quiet) {
    process.exit(await runOnce(flags));
  }

  // Interactive TUI mode
  checkTTY();

  // Enter raw TUI mode
  process.stdout.write(HIDE_CURSOR + CLEAR_SCREEN);

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
  process.stdout.write(SHOW_CURSOR);
  console.error(err);
  process.exit(EXIT_DEPENDENCY);
});
