import { platform, arch } from "os";

export function mapStainlessOs() {
  switch (platform()) {
    case "darwin": return "MacOS";
    case "win32": return "Windows";
    case "linux": return "Linux";
    case "freebsd": return "FreeBSD";
    default: return `Other::${platform()}`;
  }
}

export function mapStainlessArch() {
  switch (arch()) {
    case "x64": return "x64";
    case "arm64": return "arm64";
    case "ia32": return "x86";
    default: return `other::${arch()}`;
  }
}

export function hostPlatform() {
  return platform();
}

export function hostArch() {
  return arch();
}

export function qwenOsArch() {
  const os = platform() === "win32" ? "windows" : platform() === "darwin" ? "darwin" : "linux";
  const a = arch() === "arm64" ? "arm64" : "x64";
  return { os, arch: a, stainlessOs: mapStainlessOs(), stainlessArch: mapStainlessArch() };
}
