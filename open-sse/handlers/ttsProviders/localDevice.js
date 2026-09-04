// Local device TTS — macOS `say` + Windows SAPI + ffmpeg
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

let _voicesCache = null;

async function fetchVoicesMac() {
  const { stdout } = await execFileAsync("say", ["-v", "?"]);
  const voices = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([^\s].*?)\s{2,}([a-z]{2}_[A-Z]{2})/);
    if (!m) continue;
    const name = m[1].trim();
    const locale = m[2].trim();
    const lang = locale.split("_")[0];
    const country = locale.split("_")[1];
    voices.push({ id: name, name, locale, lang, country, gender: "" });
  }
  return voices;
}

async function fetchVoicesWin() {
  const script = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$s.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo;",
    "[PSCustomObject]@{ Name=$v.Name; Culture=$v.Culture.Name; Gender=$v.Gender } }",
    "| ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    { windowsHide: true }
  );
  const raw = JSON.parse(stdout.trim() || "[]");
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((v) => {
    const culture = v.Culture || "en-US";
    const [lang, country = ""] = culture.split("-");
    const genderMap = { 1: "Male", 2: "Female", Male: "Male", Female: "Female" };
    return {
      id: v.Name, name: v.Name,
      locale: culture.replace("-", "_"),
      lang, country,
      gender: genderMap[v.Gender] || "",
    };
  });
}

export async function fetchLocalDeviceVoices() {
  if (_voicesCache) return _voicesCache;
  try {
    const voices = process.platform === "win32" ? await fetchVoicesWin() : await fetchVoicesMac();
    _voicesCache = voices;
    return voices;
  } catch {
    return [];
  }
}

// execFile ENOENT carries only a syscall/path — name the missing binary so the
// client can tell `say` (macOS) from `ffmpeg` apart.
async function execNamed(binary, args, options) {
  try {
    return await execFileAsync(binary, args, options);
  } catch (error) {
    if (error?.code === "ENOENT") {
      const named = new Error(`local-device TTS requires '${binary}' but it is not installed (${error.message})`);
      named.code = error.code;
      throw named;
    }
    throw error;
  }
}

async function synthesizeMac(text, voiceId, signal) {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const aiffPath = join(dir, "out.aiff");
  const mp3Path = join(dir, "out.mp3");
  try {
    const args = voiceId ? ["-v", voiceId, "-o", aiffPath, text] : ["-o", aiffPath, text];
    await execNamed("say", args, { signal });
    await execNamed("ffmpeg", ["-y", "-i", aiffPath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3Path], { signal });
    const buf = await readFile(mp3Path);
    return buf.toString("base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function synthesizeWin(text, voiceId, signal) {
  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const wavPath = join(dir, "out.wav");
  const mp3Path = join(dir, "out.mp3");
  const voice = voiceId || "Microsoft David Desktop";
  const script = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    `$s.SelectVoice('${voice.replace(/'/g, "''")}');`,
    `$s.SetOutputToWaveFile('${wavPath.replace(/'/g, "''")}');`,
    `$s.Speak([System.IO.File]::ReadAllText('${join(dir, "in.txt").replace(/'/g, "''")}'));`,
    "$s.Dispose();",
  ].join(" ");
  try {
    await writeFile(join(dir, "in.txt"), text, "utf8");
    await execNamed("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], { windowsHide: true, signal });
    await execNamed("ffmpeg", ["-y", "-i", wavPath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3Path], { signal });
    const buf = await readFile(mp3Path);
    return buf.toString("base64");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const moduleDefault = {
  noAuth: true,
  async synthesize(text, model, _credentials, _responseFormat, opts = {}) {
    const signal = opts?.signal;
    if (process.platform === "win32") {
      const base64 = await synthesizeWin(text, model, signal);
      return { base64, format: "mp3" };
    }
    if (process.platform === "darwin") {
      const base64 = await synthesizeMac(text, model, signal);
      return { base64, format: "mp3" };
    }
    const error = new Error(`local-device TTS is not supported on ${process.platform} (macOS 'say' or Windows SAPI required)`);
    error.status = 501;
    throw error;
  },
};

export default moduleDefault;
