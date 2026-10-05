import { chromium } from '@playwright/test';
for (const channel of ['msedge', 'chrome']) {
  try {
    const b = await chromium.launch({ channel, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
    const ctx = await b.newContext({ permissions: ['camera'] });
    const p = await ctx.newPage();
    await p.goto('http://localhost:8080/api/health');
    const r = await p.evaluate(async () => {
      const out = {};
      try { out.devices = (await navigator.mediaDevices.enumerateDevices()).map(d => d.kind + ':' + d.label); } catch (e) { out.enumErr = e.name; }
      try { const s = await navigator.mediaDevices.getUserMedia({ video: true }); out.track = s.getVideoTracks()[0].label + ' ' + JSON.stringify(s.getVideoTracks()[0].getSettings()); } catch (e) { out.gumErr = e.name + ' ' + e.message; }
      try { const s = await navigator.mediaDevices.getUserMedia({ audio:false, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } }); out.track2 = JSON.stringify(s.getVideoTracks()[0].getSettings()); } catch (e) { out.gumErr2 = e.name + ' ' + e.message; }
      return out;
    });
    console.log(channel, JSON.stringify(r));
    await b.close();
  } catch (e) { console.log(channel, 'launch failed', e.message.split('\n')[0]); }
}
