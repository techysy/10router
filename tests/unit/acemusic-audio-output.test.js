// ACE Music (acemusic.ai) integration — issue: "生歌直接下载是MP4格式，交给 agent 它的
// url 和 key，直接可以拿歌"。The upstream speaks OpenAI Chat Completions with the audio
// dialect: lyrics in message.content/delta.content, the whole song (base64 MP3 data URI)
// in ONE frame on message.audio[] / delta.audio[]. Every layer that classifies "does this
// chunk count as content" must recognize that field, or the music frame is silently
// dropped / the combo falls through a perfectly good song.
import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDER_CAPABILITIES, getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { hasValuableContent } from "../../open-sse/utils/streamHelpers.js";
import { isZeroContentResponse } from "../../open-sse/services/combo.js";
import { inspectNonStream, createStreamScanner } from "../../open-sse/services/sensitiveRetry.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { extractMusicResponse, buildStepfunSubmitBody, extractStepfunMusicResponse } from "../../src/sse/handlers/music.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const enc = new TextEncoder();

const STEP_MUSIC_CONFIG = {
  mode: "stepfun-async",
  modelIdUpstream: "stepaudio-3-music-preview",
  defaultResponseFormat: "mp3",
};

// The exact wire shape observed on api.acemusic.ai (2026-11-05):
// 5 frames — role+content("") → content(lyrics) → audio(whole song) → finish → [DONE]
const AUDIO_FRAME = {
  id: "chatcmpl-1",
  object: "chat.completion.chunk",
  choices: [{
    index: 0,
    delta: { audio: [{ type: "audio_url", audio_url: { url: "data:audio/mpeg;base64,SUQzBA…" } }] },
  }],
};

describe("acemusic registry + capabilities", () => {
  it("is registered as a music-kind provider with the live-catalog model", () => {
    const p = REGISTRY.find((x) => x.id === "acemusic");
    expect(p).toBeDefined();
    // Upstream id carries an acemusic/ namespace equal to the provider id; the
    // registry stores the BARE id + upstreamModelId so clients see a single
    // acemusic/ prefix instead of acemusic/acemusic/... (user-reported).
    expect(p.models).toEqual([
      { id: "acestep-v1.5-turbo", name: "ACE-Step", kind: "music", upstreamModelId: "acemusic/acestep-v1.5-turbo" },
    ]);
    // music-only: hidden from the regular providers page, listed under 媒体提供商 → 音乐
    expect(p.serviceKinds).toEqual(["music"]);
    expect(p.transport.baseUrl).toBe("https://api.acemusic.ai/v1/chat/completions");
    expect(p.transport.validateUrl).toBe("https://api.acemusic.ai/v1/models");
  });

  it("resolves audio capabilities without falling to the 200K floor", () => {
    const caps = getCapabilitiesForModel("acemusic", "acemusic/acestep-v1.5-turbo");
    expect(caps.audioInput).toBe(true);
    expect(caps.audioOutput).toBe(true);
    expect(caps.contextWindow).toBe(4096);
    // resolver materializes DEFAULT_CAPABILITIES: vision explicitly false (images stripped)
    expect(caps.vision).toBe(false);
    // bare-id (client sends acemusic/acestep-v1.5-turbo → resolver strips provider prefix)
    // and display-name lookups hit the same row
    expect(getCapabilitiesForModel("acemusic", "acestep-v1.5-turbo")).toEqual(caps);
    expect(getCapabilitiesForModel("acemusic", "ACE-Step")).toEqual(caps);
    expect(PROVIDER_CAPABILITIES.acemusic["acestep-v1.5-turbo"]).toBeDefined();
  });

  it("prices at zero per the upstream model card", () => {
    expect(getPricingForModel("acemusic", "acemusic/acestep-v1.5-turbo")).toMatchObject({
      input: 0, output: 0,
    });
  });
});

describe("extractMusicResponse — /v1/audio/music response shaping", () => {
  it("reshapes the chat audio dialect into { data: [{url, format}] }", () => {
    const r = extractMusicResponse({
      choices: [{
        message: {
          role: "assistant",
          content: "## Metadata\n**Caption:** neon nights",
          audio: [{ type: "audio_url", audio_url: { url: "data:audio/mpeg;base64,SUQzBA…" } }],
        },
        finish_reason: "stop",
      }],
      usage: { completion_tokens: 100 },
    });
    expect(r.data).toEqual([{ url: "data:audio/mpeg;base64,SUQzBA…", format: "mp3" }]);
    expect(r.content).toBe("## Metadata\n**Caption:** neon nights");
    expect(r.usage).toEqual({ completion_tokens: 100 });
  });

  it("maps container formats from the MIME type (mp4/wav/ogg)", () => {
    const mk = (mime) => extractMusicResponse({
      choices: [{ message: { audio: [{ audio_url: { url: `data:${mime};base64,AA` } }] } }],
    });
    expect(mk("audio/mp4").data[0].format).toBe("mp4");
    expect(mk("audio/wav").data[0].format).toBe("wav");
    expect(mk("audio/ogg").data[0].format).toBe("ogg");
    expect(mk("audio/mpeg").data[0].format).toBe("mp3");
  });

  it("errors honestly when the upstream produced no audio", () => {
    expect(extractMusicResponse({ choices: [{ message: { content: "sorry" } }] }).error)
      .toMatch(/no audio/);
    expect(extractMusicResponse(null).error).toMatch(/no audio/);
  });
});

describe("StepFun native async music (stepaudio-3-music-preview)", () => {
  it("registers stepfun with music kind and the native-async musicConfig", () => {
    const p = REGISTRY.find((x) => x.id === "stepfun");
    expect(p.serviceKinds).toContain("music");
    expect(p.models.find((m) => m.id === "stepaudio-3-music-preview")).toMatchObject({ kind: "music" });
    expect(p.musicConfig).toMatchObject({
      mode: "stepfun-async",
      modelIdUpstream: "stepaudio-3-music-preview",
      defaultResponseFormat: "mp3",
    });
  });

  it("multi-line prompt drives lyrics + first-line caption (user pastes full lyrics)", () => {
    const submit = buildStepfunSubmitBody(
      { prompt: "《亨利哥之歌》\n（主歌1）\n昵称改了一年半\n（副歌）\n亨利哥最帅" },
      STEP_MUSIC_CONFIG,
    );
    expect(submit.task).toBe("text_to_music");
    expect(submit.model_id).toBe("stepaudio-3-music-preview");
    expect(submit.caption).toBe("《亨利哥之歌》");
    expect(submit.lyrics).toContain("（主歌1）");
    expect(submit.response_format).toBe("mp3");
  });

  it("one-line prompt stays caption (server auto-writes lyrics)", () => {
    const submit = buildStepfunSubmitBody(
      { prompt: "An upbeat city-pop track about sunny mornings" },
      STEP_MUSIC_CONFIG,
    );
    expect(submit.caption).toBe("An upbeat city-pop track about sunny mornings");
    expect(submit.lyrics).toBeUndefined();
  });

  it("explicit caption/lyrics/instrumental win over the prompt heuristic", () => {
    const submit = buildStepfunSubmitBody(
      { prompt: "whatever", caption: "lo-fi, warm female vocal", lyrics: "[Verse 1]\nhi", instrumental: true },
      STEP_MUSIC_CONFIG,
    );
    expect(submit.caption).toBe("lo-fi, warm female vocal");
    expect(submit.lyrics).toBe("[Verse 1]\nhi");
    expect(submit.instrumental).toBe(true);
  });

  it("SUCCESS payload reshapes raw base64 into a data URI + rewritten lyrics", () => {
    const r = extractStepfunMusicResponse({
      status: "SUCCESS",
      audio: "SUQzBA==",
      response_format: "mp3",
      rewritten_lyrics: "[Verse 1]\nrewritten",
      lyrics: "[Verse 1]\noriginal",
    }, STEP_MUSIC_CONFIG);
    expect(r.data).toEqual([{ url: "data:audio/mpeg;base64,SUQzBA==", format: "mp3" }]);
    expect(r.content).toBe("[Verse 1]\nrewritten");
    expect(r.model).toBe("stepaudio-3-music-preview");
  });

  it("FAILED is a business terminal with stage detail", () => {
    const r = extractStepfunMusicResponse({
      status: "FAILED",
      error: { stage: "censor", message: "blocked" },
    }, STEP_MUSIC_CONFIG);
    expect(r.error).toMatch(/censor.*blocked/s);
  });

  it("declares audio caps and zero pricing", () => {
    const caps = getCapabilitiesForModel("stepfun", "stepaudio-3-music-preview");
    expect(caps.audioInput).toBe(true);
    expect(caps.audioOutput).toBe(true);
    expect(getPricingForModel("stepfun", "stepaudio-3-music-preview").input).toBe(0);
  });
});

describe("audio frame is never dropped or misclassified", () => {
  it("hasValuableContent recognizes delta.audio (passthrough would drop the song frame otherwise)", () => {
    expect(hasValuableContent(AUDIO_FRAME, FORMATS.OPENAI)).toBe(true);
  });

  it("isZeroContentResponse treats message.audio as usable content (no combo fall-through)", () => {
    // audio-only answer (no lyrics text) is still a complete song
    expect(isZeroContentResponse({
      choices: [{ message: { content: "", audio: [{ audio_url: { url: "data:audio/mpeg;base64,x" } }] }, finish_reason: "stop" }],
    })).toBe(false);
    // lyrics + audio — the real acemusic shape
    expect(isZeroContentResponse({
      choices: [{ message: { content: "## Metadata\n**Caption:** …", audio: [{ audio_url: { url: "data:…" } }] }, finish_reason: "stop" }],
    })).toBe(false);
    // audio + reasoning but no content must NOT trip the issue #96 reasoning-only rule
    expect(isZeroContentResponse({
      choices: [{ message: { content: "", reasoning_content: "composing…", audio: [{ audio_url: { url: "data:…" } }] }, finish_reason: "stop" }],
    })).toBe(false);
  });

  it("inspectNonStream keeps an audio answer non-retryable", () => {
    const r = inspectNonStream({
      choices: [{ message: { content: "", audio: [{ audio_url: { url: "data:…" } }] }, finish_reason: "stop" }],
    });
    expect(r.retryable).toBe(false);
  });

  it("stream scanner commits on the audio frame instead of buffering to terminal", () => {
    const s = createStreamScanner();
    expect(s.push(enc.encode(`data: ${JSON.stringify(AUDIO_FRAME)}\n\n`)).kind).toBe("commit");
    expect(s.push(enc.encode("data: whatever\n\n")).kind).toBe("passthrough");
  });
});
