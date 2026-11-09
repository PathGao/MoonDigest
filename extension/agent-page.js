// The video page's side of MoonDigest's agent interface (docs/AGENT.md §1): agents' page JS asks with
// window.postMessage (moondigest-get, moondigest-frame), the service worker's MCP bridge with chrome.runtime
// { type: "agent-call", method, params }, and both get the same handlers.
//   MdgAgentPage.bind({ read, signal })
//     read()  → §1's get data for the page's current video, or rejects with an Error carrying code.
//     signal  → an AbortSignal that removes the listeners (optional).
(() => {
  if (globalThis.MdgAgentPage) {
    return;
  }

  const VERSION = 1;
  const SEEK_TIMEOUT_MS = 15000;
  // Under the MCP server's 60 s TIMEOUT with the seek and the page load added, so an agent there gets AD_PLAYING.
  const AD_TIMEOUT_MS = 30000;
  const JPEG_QUALITY = 0.85;
  const DEFAULT_MAX_WIDTH = 1280;
  const PAGE_TYPES = { "moondigest-get": "get", "moondigest-frame": "frame" };
  const SKIP_AD = ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern";

  const fail = (message, code) => Object.assign(new Error(message), code ? { code } : {});
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = (node) => Boolean(node && node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");

  // The page's main <video>: the largest one on screen, else the first.
  function mainVideo() {
    const videos = [...document.querySelectorAll("video")];
    const area = (video) => {
      const rect = video.getBoundingClientRect();
      return rect.width * rect.height;
    };
    return videos.sort((a, b) => area(b) - area(a))[0] || null;
  }

  // YouTube plays an ad in the same <video>: wait it out, skipping it when YouTube offers to.
  async function waitAds() {
    const end = Date.now() + AD_TIMEOUT_MS;
    for (;;) {
      if (!document.querySelector("#movie_player.ad-showing")) return;
      if (Date.now() > end) throw fail("YouTube is playing an ad that cannot be skipped yet; try again later", "AD_PLAYING");
      const skip = [...document.querySelectorAll(SKIP_AD)].find(visible);
      skip?.click();
      await sleep(500);
    }
  }

  // Resolves once `event` fires on video, or when ready() already holds; rejects with error after ms.
  function waitEvent(video, event, ms, error, ready = () => false) {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener(event, done);
        resolve();
      };
      const timer = setTimeout(() => {
        video.removeEventListener(event, done);
        reject(error);
      }, ms);
      video.addEventListener(event, done);
      if (ready()) done();
    });
  }

  async function frame(params = {}) {
    const at = Number(params.at);
    if (params.at === undefined || params.at === null || !Number.isFinite(at) || at < 0) throw fail("`at` must be a number of seconds, 0 or more");
    const maxWidth = Number(params.maxWidth) > 0 ? Math.floor(Number(params.maxWidth)) : DEFAULT_MAX_WIDTH;
    await waitAds();
    const video = mainVideo();
    if (!video) throw fail("There is no <video> on this page", "NO_VIDEO");
    // Chrome loads no media in a tab that has never been shown: seeking there would only time out.
    if (video.readyState === 0 && document.visibilityState === "hidden") {
      throw fail("Chrome does not load the video in a background tab that has never been shown: bring the tab to the front once, then try again", "TAB_HIDDEN");
    }
    video.pause();
    const end = Date.now() + SEEK_TIMEOUT_MS;
    const timeout = () => fail(`The video did not seek to ${at}s within ${SEEK_TIMEOUT_MS / 1000}s`, "SEEK_TIMEOUT");
    // currentTime can only be set once the duration is known.
    await waitEvent(video, "loadedmetadata", SEEK_TIMEOUT_MS, timeout(), () => video.readyState >= 1);
    const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(at, video.duration) : at;
    const seeked = waitEvent(video, "seeked", Math.max(0, end - Date.now()), timeout());
    video.currentTime = target;
    await seeked;
    // HAVE_CURRENT_DATA: the frame at currentTime is decoded.
    await waitEvent(video, "loadeddata", Math.max(0, end - Date.now()), timeout(), () => video.readyState >= 2);
    if (!video.videoWidth || !video.videoHeight) throw fail("The video has no picture yet", "NO_VIDEO");
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    let image;
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, width, height);
      image = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    } catch (error) {
      if (error?.name === "SecurityError") throw fail("The browser blocks reading this video's pixels", "FRAME_BLOCKED");
      throw error;
    }
    return { at: video.currentTime, width, height, image };
  }

  // { ok: true, data } or { ok: false, error, code? }: the reply both channels carry.
  async function run(handlers, method, params) {
    try {
      if (!Object.hasOwn(handlers, method)) throw fail(`Unknown method: ${method}`);
      return { ok: true, data: await handlers[method](params || {}) };
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      return { ok: false, error: String(error?.message || error || "Unknown error"), ...(code ? { code } : {}) };
    }
  }

  function bind({ read, signal } = {}) {
    // The top frame only: one answer per tab (chrome.tabs.sendMessage without a frameId reaches every frame).
    if (window !== window.top) return;
    // A get joins the read in flight: the skill resends until the page answers, and each resend must not read again.
    // Frames run one after another: a second seek would cut the first short and both would get its picture.
    let reading = null;
    let frames = Promise.resolve();
    const handlers = {
      get: () => (reading ||= Promise.resolve().then(read).finally(() => (reading = null))),
      frame: (params) => {
        const run = frames.then(() => frame(params));
        frames = run.catch(() => {});
        return run;
      }
    };

    const onPage = (event) => {
      const message = event.data;
      if (event.source !== window || !message || typeof message !== "object") return;
      const method = PAGE_TYPES[message.type];
      if (!method) return;
      const { type, id, ...params } = message;
      run(handlers, method, params).then((reply) => {
        window.postMessage({ source: "moondigest", id, version: VERSION, ...reply }, location.origin);
      });
    };
    window.addEventListener("message", onPage, signal ? { signal } : undefined);

    const onRuntime = (message, _sender, sendResponse) => {
      if (message?.type !== "agent-call") return false;
      run(handlers, message.method, message.params).then(sendResponse);
      return true;
    };
    chrome.runtime.onMessage.addListener(onRuntime);
    signal?.addEventListener("abort", () => chrome.runtime.onMessage.removeListener(onRuntime), { once: true });
  }

  globalThis.MdgAgentPage = Object.freeze({ bind, VERSION });
})();
