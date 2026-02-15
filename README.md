# dikt

Voice dictation for the terminal. Record, transcribe, copy — zero npm dependencies.

Uses [Mistral's Voxtral](https://docs.mistral.ai/capabilities/audio/) for speech-to-text.

## Install

```
npm install -g dikt
```

Requires [sox](https://sox.sourceforge.net/) for audio recording:

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

### Update

```
dikt update
```

### Single-shot mode

```bash
# Print transcript to stdout
dikt -q

# Output JSON
dikt --json

# Pipe to another tool
dikt -q | claude
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
