export interface Cue {
  start: number;
  end: number;
  text: string;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function fmtVTT(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function fmtSRT(t: number): string {
  return fmtVTT(t).replace('.', ',');
}

export function toVTT(cues: Cue[]): string {
  const body = cues
    .map((c, i) => `${i + 1}\n${fmtVTT(c.start)} --> ${fmtVTT(c.end)}\n${c.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

export function toSRT(cues: Cue[]): string {
  return (
    cues.map((c, i) => `${i + 1}\n${fmtSRT(c.start)} --> ${fmtSRT(c.end)}\n${c.text}`).join('\n\n') + '\n'
  );
}

export function fmtTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
