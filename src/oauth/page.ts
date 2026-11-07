const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1b1b1b;--muted:#666;--accent:#007cc3;--err:#b3261e;--border:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1e1e1e;--fg:#eee;--muted:#aaa;--border:#333}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;padding:16px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}strong{color:var(--fg)}
label{display:block;font-weight:600;margin:0 0 6px}input[type=password]{width:100%;padding:10px 12px;font-size:16px;border:1px solid var(--border);border-radius:8px;background:transparent;color:var(--fg)}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:10px;font-size:16px;border-radius:8px;border:1px solid var(--border);cursor:pointer;background:transparent;color:var(--fg)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}.err{color:var(--err);margin-bottom:12px}code{font-size:13px;word-break:break-all}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function consentPage(opts: {
  clientName: string;
  redirectHost: string;
  params: Record<string, string>;
  error?: string;
}): string {
  const hidden = Object.entries(opts.params)
    .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`)
    .join('');
  return layout(
    'Authorize Garmin MCP',
    `<h1>Connect Garmin data</h1>
<p><strong>${escape(opts.clientName)}</strong> wants read access to your Garmin Connect data. It will return to <code>${escape(opts.redirectHost)}</code>.</p>
${opts.error ? `<p class="err">${escape(opts.error)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<label for="password">Owner password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
<div class="row"><button type="submit" name="decision" value="deny">Deny</button><button class="primary" type="submit" name="decision" value="approve">Approve</button></div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return layout('Authorization error', `<h1>Authorization error</h1><p class="err">${escape(message)}</p>`);
}
