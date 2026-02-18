# dikt

Voice dictation for the terminal. Record, transcribe, copy — zero npm dependencies.

Uses [Mistral's Voxtral](https://docs.mistral.ai/capabilities/audio/) for speech-to-text.

## Install

```
npm install -g dikt
```

Requires [sox](https://sox.sourceforge.net/) for audio recording (not needed for `--file`):

```bash
# macOS
brew install sox

# Ubuntu/Debian
sudo apt install sox

# Arch
sudo pacman -S sox
```

## Setup

On first run, dikt will prompt you for your Mistral API key and model preferences:

```
dikt setup
```

Config is stored in `~/.config/dikt/config.json`.

## Usage

```
dikt
```

This opens an interactive TUI where you can record, transcribe, and copy text.

### Keys

| Key | Action |
|---|---|
| `Space` | Start / stop recording |
| `c` / `Enter` | Copy transcript to clipboard |
| `a` | Toggle auto-copy |
| `h` | Cycle through history |
| `r` | Re-transcribe last recording |
| `Esc` | Cancel recording |
| `s` | Re-run setup |
| `?` | Show keybindings |
| `q` | Quit |

### Single-shot mode

```bash
# Print transcript to stdout
dikt -q

# Output JSON
dikt --json

# Pipe to another tool
dikt -q | claude

# Wait longer before auto-stopping
dikt -q --silence 5
```

### Stream mode

Continuously transcribe, emitting chunks on pauses:

```bash
dikt --stream

# Stream as JSON Lines
dikt --stream --json

# Stream as continuous flowing text
dikt --stream -n

# Stream continuously until Ctrl+C
dikt --stream --silence 0
```

### File mode

Transcribe an existing audio file (wav, mp3, m4a, flac, ogg, webm — no sox needed):

```bash
dikt --file meeting.wav

# Save to a file (.json auto-enables JSON output)
dikt --file meeting.wav -o transcript.json
dikt --file meeting.wav -o transcript.txt

# With JSON output
dikt --file recording.mp3 --json
```

### Speaker identification & timestamps

```bash
# Speaker labels
dikt -q --diarize

# Timestamps
dikt -q --timestamps segment
dikt -q --timestamps word
dikt -q --timestamps segment,word

# Combined with JSON
dikt -q --json --diarize
```

### Options

| Flag | Description |
|---|---|
| `--file <path>` | Transcribe an audio file (no mic needed) |
| `-o`, `--output <path>` | Write output to file (`.json` auto-enables JSON) |
| `--stream` | Stream transcription chunks on pauses |
| `--json` | Output JSON (single-shot or stream) |
| `-q`, `--quiet` | Record once, print transcript to stdout |
| `--silence <seconds>` | Silence duration before auto-stop (default: 2.0) |
| `--pause <seconds>` | Pause duration to split stream chunks (default: 1.0) |
| `--language <code>` | Language code, e.g. en, de, fr (default: auto) |
| `--timestamps <granularity>` | Add timestamps: segment, word, or segment,word |
| `--diarize` | Enable speaker identification |
| `-n`, `--no-newline` | Join stream chunks without newlines |
| `--no-color` | Disable colored output |
| `--no-input` | Fail if config is missing (no wizard) |
| `--setup` | Run setup wizard |
| `--update` | Update to latest version |
| `--version` | Show version |
| `-h`, `--help` | Show help |

### Update

```
dikt update
```

## Environment variables

| Variable | Description |
|---|---|
| `DIKT_API_KEY` | Override API key |
| `DIKT_MODEL` | Override model (default: `voxtral-mini-latest`) |
| `DIKT_LANGUAGE` | Override language (default: auto) |
| `DIKT_TEMPERATURE` | Override temperature |
| `DIKT_CONTEXT_BIAS` | Override context bias |

## License

MIT
