---
name: moondigest
description: Read and watch a Bilibili or YouTube video through the user's own browser. Open the video page in a browser that has the MoonDigest extension, get title, description, chapters, timestamped transcript and hot comments in one call, then grab frames at the moments worth seeing. Use when the user gives a bilibili.com / b23.tv / youtube.com / youtu.be link, or asks to summarize, check or quote a video. No download, no local transcription.
---

# MoonDigest: read a video in the browser

The MoonDigest extension answers JS running in a Bilibili or YouTube video page. It reads the video the way the page does, with the user's login, so Bilibili's login-only subtitles work and there is no 429 / 412 from a server IP. It is read-only: no AI quota, no access to the user's notes or keys. The full contract is in [docs/AGENT.md](../../docs/AGENT.md).

## Before you start

- The browser you drive (ego, Claude in Chrome, Playwright with the user's profile, …) has MoonDigest installed and enabled.
- Bilibili shows subtitles (AI subtitles too) only to logged-in users. If `subtitle.needLogin` is `true`, ask the user to log in. Never type their password.
- If you have no browser but the `moondigest` MCP server is configured, use its `get_video` and `get_frame` tools instead of this skill. The MCP takes full video URLs only (`bilibili.com/video/…`, `youtube.com/watch?v=…`), not b23.tv or youtu.be short links.

## 1. Open the page

Open the video URL and wait for it to load. b23.tv and youtu.be short links redirect by themselves. For a Bilibili multi-part video pick the part with `?p=N`.

## 2. Get the transcript and info

Run this in the page (`page.evaluate`, `javascript_tool`, …). `moondigest-get` is resent every 2 s because the extension attaches only after the page loads, and fails after 30 s. Define `moondigest` again in each evaluate call if your tool does not keep page globals.

```js
const moondigest = (type, params = {}) => new Promise((resolve, reject) => {
  const id = crypto.randomUUID();
  const send = () => postMessage({ type, id, ...params }, location.origin);
  // Only get is resent: a frame is asked after get answered, and resending a slow frame would seek twice.
  const retry = type === "moondigest-get" ? setInterval(send, 2000) : 0;
  const timer = setTimeout(() => done(new Error("MoonDigest did not answer: the extension is missing or off, or this is not a video page")), type === "moondigest-frame" ? 90000 : 30000);
  const done = (error, data) => {
    clearInterval(retry);
    clearTimeout(timer);
    removeEventListener("message", on);
    error ? reject(error) : resolve(data);
  };
  const on = (e) => {
    if (e.source !== window || e.data?.source !== "moondigest" || e.data.id !== id) return;
    clearInterval(retry);
    e.data.ok ? done(null, e.data.data) : done(Object.assign(new Error(e.data.error), { code: e.data.code }));
  };
  addEventListener("message", on);
  send();
});
await moondigest("moondigest-get");
```

What comes back:

| field | content |
|---|---|
| `url` `site` `videoId` | page URL, `bilibili` or `youtube`, BV id or YouTube id |
| `title` `author` `uploadDate` `duration` | title, uploader or channel, date, length in seconds |
| `description` | description |
| `part` | `{ index, count, title }`, Bilibili parts; `count` 0 means a single part |
| `chapters` | `[{ title, from, to }]`, seconds |
| `subtitle.segments` | `[{ from, to, content }]`, seconds |
| `subtitle.lang` `subtitle.warning` | track language; a note when the subtitle's timing does not match the video |
| `subtitle.missing` `subtitle.needLogin` | why there is no subtitle (`""` when there is one); whether Bilibili needs a login |
| `comments` | `[{ uname, like, message }]`, hot comments |

For a long video read the chapters and description first, then the transcript chapter by chapter, instead of loading everything at once.

## 3. Look at frames

The transcript is only the sound. To check a chart, code, a demo step or on-screen text, look at that moment.

`moondigest-frame` pauses the video, seeks to `at` seconds and returns a JPEG of the video itself (no Bilibili danmaku over it). On YouTube it waits for an ad to finish first.

```js
const f = await moondigest("moondigest-frame", { at: 754, maxWidth: 1280 });
// f = { at, width, height, image: "data:image/jpeg;base64,…" }
```

Never print `f.image` into your context: it is tens of thousands of characters. Either:

- Your evaluate runs from a script that can write files (Playwright, ego's Node scripts): write `f.image`'s base64 to a `.jpg` and open it as an image.
- Your browser tool can only return text: call `moondigest-frame` and return only `f.at`; the video is now paused on that frame, so take a screenshot with your browser tool. On Bilibili, turn danmaku off first (the 弹 switch under the player).

One time point at a time.

## 4. Cite

Back conclusions with timestamps the user can click: `12:34`, as Bilibili `…/video/BVxxx?t=754` or YouTube `…/watch?v=xxx&t=754s`. Subtitles may be machine-generated: when a name or number matters and you are unsure, check a frame or say it is uncertain.

## When it fails

- `subtitle.missing` is not empty: the video has no subtitle or it could not be read. Use the description, chapters, comments and frames, and tell the user there was no subtitle.
- `code` `THROTTLED`: Bilibili or YouTube is rate-limiting. Stop and tell the user. Do not retry soon; YouTube's subtitle limit can last hours.
- `code` `NOT_VIDEO_PAGE`: open a specific video, not a home, search or channel page.
- `code` `AD_PLAYING`: a YouTube ad did not end in 30 s. Try again later or screenshot instead.
- No answer at all: the extension is not installed or is disabled in this browser.
- Read one video at a time. Many videos in parallel or dozens in a row trigger the platforms' anti-bot checks.
