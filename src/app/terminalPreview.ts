export async function renderTerminalPreview(snapshot: string, truncated = false): Promise<string> {
  if (!snapshot) return "";
  const { Terminal } = await import("@xterm/xterm");
  const terminal = new Terminal({
    cols: 320,
    rows: 100,
    scrollback: 200,
    allowProposedApi: true,
    disableStdin: true,
  });
  let replay = snapshot;
  if (truncated) {
    const boundary = snapshot.search(/[\x1b\r\n]/);
    if (boundary > 0) replay = snapshot.slice(boundary);
  }
  try {
    await new Promise<void>(resolve => terminal.write(replay, resolve));
    const buffer = terminal.buffer.active;
    let text = "";
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index);
      if (!line) continue;
      if (index > 0 && !line.isWrapped) text += "\n";
      text += line.translateToString(true);
    }
    return text.trim();
  } finally {
    terminal.dispose();
  }
}
