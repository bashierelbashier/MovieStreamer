# MovieStreamer

A tiny TV-style movie broadcaster. One movie streams from the server to every
connected browser at the same time — like a channel, not on-demand. Viewers just
watch; they can't pause, seek, or rewind.

## Requirements

- Node.js 24+ — nothing else. No ffmpeg, no dependencies.

## Use it in the browser

1. **Add a movie.** Drop one video file into the `current_movie/` folder.
   Supported: `.mp4`, `.m4v`, `.mov`, `.webm` (the formats browsers play natively).
   *(Optional: drop a `.srt` or `.vtt` subtitle file next to it — it's picked up automatically.)*

2. **Start the server.**

   ```bash
   npm start
   ```

   You'll see:

   ```
   MovieStreamer → http://localhost:3000
   ```

3. **Go live.** Tell the server to begin broadcasting — just open this in your browser:

   ```
   http://localhost:3000/start-streaming
   ```

   (Or from the terminal: `curl http://localhost:3000/start-streaming`)

4. **Watch.** Open this in your browser:

   ```
   http://localhost:3000/watch
   ```

   The page waits for the broadcast and connects automatically once it's live.
   Open it in multiple tabs or on other devices on your network
   (`http://<your-ip>:3000/watch`) — everyone sees the same moment.

## How it behaves

- The movie plays continuously whether anyone is watching or not, like a TV channel.
- Viewers who join late catch the stream **at the current moment**, not from the start.
- `/pause-streaming` is an intermission: the broadcast clock stops and every
  viewer freezes together (the badge switches to **INTERMISSION**). Hit it
  again and everyone resumes at the same moment. Viewers still control nothing.
- `/end-streaming` cuts the broadcast immediately; every viewer sees "The show
  has ended" within a couple of seconds.
- When the movie ends, the broadcast stops on its own. Call `/start-streaming`
  again to replay.
- On the watch page, the clock, fullscreen toggle, and mouse cursor disappear
  after 3 seconds of inactivity — move the mouse to bring them back.

## How it works

`/start-streaming` starts the **broadcast clock**: the server probes the movie's
duration (pure Node — it reads the MP4 `mvhd` box or the WebM header) and marks
the moment the show began. The clock runs whether anyone is watching or not,
and when it reaches the movie's duration the broadcast ends.

The video itself is served with plain **HTTP range requests** (`206 Partial
Content`, 1 MB chunks), so the browser buffers and plays it natively — perfectly
smooth. The `/watch` page joins at the clock's current moment and re-syncs to it
every couple of seconds, so everyone sees the same instant and nobody can pause,
seek, or rewind. (Streaming model based on
[WittCode's video streaming app](https://github.com/WittCode/code-a-video-streaming-app-with-node).)

## Endpoints

| Method     | Path                | Purpose                                            |
| ---------- | ------------------- | -------------------------------------------------- |
| `GET/POST` | `/start-streaming`  | Begin broadcasting the file in `current_movie/`.   |
| `GET/POST` | `/pause-streaming`  | Toggle intermission: pause the broadcast for everyone; call again to resume. |
| `GET/POST` | `/end-streaming`    | End the broadcast for everyone, immediately.       |
| `GET`      | `/watch`            | The theater page.                                  |
| `GET`      | `/video`            | The movie, in range-request chunks (used by `/watch`). |
| `GET`      | `/subtitles.vtt`    | WebVTT subtitles, if present.                      |
| `GET`      | `/status`           | Broadcast clock + state (used by `/watch`).        |

## Troubleshooting

- **Nothing plays:** make sure the file is a format browsers can decode —
  H.264/AAC `.mp4` or `.webm`. (`.mkv`/`.avi` containers aren't supported by
  browsers.)
- **Change the port:** `PORT=8080 npm start`
