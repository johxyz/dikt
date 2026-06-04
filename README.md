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

Optional dependencies for `--file` mode:

- [ffmpeg](https://ffmpeg.org/) — enables compression, chunked transcription of long files, and broader format support
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — enables transcribing audio from URLs (YouTube, podcasts, etc.)

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
| `b` | Batch jobs view (list / refresh / fetch / cancel) |
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

Transcribe an existing audio file (wav, mp3, m4a, flac, ogg, webm, aac, wma, and more):

```bash
dikt --file meeting.wav

# Save to a file (.json auto-enables JSON output)
dikt --file meeting.wav -o transcript.json
dikt --file meeting.wav -o transcript.txt

# With JSON output
dikt --file recording.mp3 --json

# Transcribe from a URL (requires yt-dlp)
dikt --file https://youtube.com/watch?v=VIDEO_ID
dikt --file https://youtube.com/watch?v=VIDEO_ID -o transcript.txt
```

### Batch mode

Transcribe many files at once through Mistral's async [Batch API](https://docs.mistral.ai/capabilities/batch/) — roughly **50% cheaper** than realtime, at the cost of latency (results arrive minutes to hours later, within a 24h window). Jobs are submitted and detached: dikt persists each job to `~/.config/dikt/batches/` so you can close the terminal and fetch results later.

```bash
# Submit files — prints a job id and exits immediately
dikt batch *.wav

# Submit every audio file in a directory
dikt batch ./recordings

# Submit and block until done, then write outputs
dikt batch *.mp3 --wait

# Check on jobs
dikt batch --list
dikt batch --status <id>

# Download results once SUCCESS (writes <name>.txt next to each source)
dikt batch --fetch <id>
dikt batch --fetch <id> --json        # write <name>.json instead
dikt batch --fetch <id> -o ./out      # write into a directory

# Cancel a queued/running job
dikt batch --cancel <id>
```

`--diarize`, `--timestamps`, `--language`, and `--json` work the same as in other modes. Job ids may be abbreviated to any unique prefix.

You can also manage jobs from the interactive TUI: press `b` to open the **batch jobs view**, where `↑`/`↓` selects a job, `r` refreshes status, `Enter` fetches a completed job, and `x` cancels one.

### Speaker identification & timestamps

```bash
# Speaker labels
dikt -q --diarize

# Timestamps
dikt -q --timestamps segment
dikt -q --timestamps word
dikt --file lecture.mp3 --timestamps segment

# Combined with JSON
dikt -q --json --diarize
```

### Options

| Flag | Description |
|---|---|
| `batch <files\|dir>` | Submit files to the async Batch API (~50% cheaper) |
| `--file <path\|url>` | Transcribe audio file or URL (via yt-dlp) |
| `-o`, `--output <path>` | Write output to file (`.json` auto-enables JSON) |
| `--stream` | Stream transcription chunks on pauses |
| `--json` | Output JSON (single-shot or stream) |
| `-q`, `--quiet` | Record once, print transcript to stdout |
| `--silence <seconds>` | Silence duration before auto-stop (default: 2.0) |
| `--pause <seconds>` | Pause duration to split stream chunks (default: 1.0) |
| `--language <code>` | Language code, e.g. en, de, fr (default: auto) |
| `--timestamps <granularity>` | Add timestamps: segment or word |
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
