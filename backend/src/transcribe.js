// Video script transcription — pulls the SPOKEN hook/script out of a video ad so
// the analysis reflects what they actually say, not just the cover frame + copy.
// Uses OpenAI Whisper (Claude can't transcribe audio); needs OPENAI_API_KEY.
// The Meta Ad Library scraper gives us the video file URL.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const cache = new Map();

export async function transcribeVideo(url) {
  if (!url || !/^https?:\/\//i.test(url) || !process.env.OPENAI_API_KEY) return '';
  if (cache.has(url)) return cache.get(url);
  try {
    const vr = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!vr.ok) { cache.set(url, ''); return ''; }
    const buf = Buffer.from(await vr.arrayBuffer());
    if (buf.length < 2000 || buf.length > 24 * 1024 * 1024) { cache.set(url, ''); return ''; } // Whisper's 25MB cap
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'video/mp4' }), 'ad.mp4');
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');
    form.append('language', process.env.WHISPER_LANG || 'en'); // force English — Whisper otherwise mis-detects some English ad audio as another language (e.g. Welsh)
    const wr = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: form,
    });
    if (!wr.ok) { cache.set(url, ''); return ''; }
    const txt = (await wr.text()).replace(/\s+/g, ' ').trim().slice(0, 2000);
    cache.set(url, txt);
    return txt;
  } catch (e) { return ''; }
}
