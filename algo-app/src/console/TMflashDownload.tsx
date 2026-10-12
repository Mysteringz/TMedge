import { useCallback, useEffect, useRef, useState } from 'react';
import { TMFLASH_REPOSITORY, parseHostedTMflashRelease, tmflashDownloadPath, type HostedTMflashRelease } from '../../../src/shared/tmflash-release.js';
import { navigate } from './router.ts';
import { ArrowRight, DownloadSimple } from './icons.tsx';
import './tmflash-download.css';

export function TMflashDownload() {
  const [release, setRelease] = useState<HostedTMflashRelease | null>(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(true);
  const request = useRef<AbortController | null>(null);
  const check = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setChecking(true);
    try {
      const response = await fetch('/api/tmflash-download/release', { signal: controller.signal });
      const body: unknown = await response.json();
      if (!response.ok) {
        setRelease(null);
        throw new Error(body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'The TMflash download is temporarily unavailable.');
      }
      // This endpoint is the console's own checked release, never a URL to
      // navigate to supplied by a third-party download host.
      setRelease(parseHostedTMflashRelease(body));
      setError('');
    } catch (cause) {
      if (controller.signal.aborted) return;
      setRelease(null);
      setError(cause instanceof Error ? cause.message : 'The download could not be checked. Try again shortly.');
    } finally { if (!controller.signal.aborted) setChecking(false); }
  }, []);
  useEffect(() => {
    void check();
    const timer = setInterval(() => { void check(); }, 60_000);
    return () => { clearInterval(timer); request.current?.abort(); };
  }, [check]);
  const fileSize = release ? release.size < 1024 * 1024 ? `${Math.ceil(release.size / 1024)} KB` : `${(release.size / (1024 * 1024)).toFixed(1)} MB` : null;

  return <main className="cx-tmflash-download">
    <p className="cx-eyebrow">Module 08 · The Mac app</p>
    <h1>TMflash download</h1>
    <p className="td-intro">Your TMsense workbench, ready to go.</p>

    <section className="td-hero" aria-labelledby="td-app-title">
      <div className="td-app">
        <img className="td-logo" src="/tmflash-logo.png" alt="TMflash: white lightning bolt on a black tile" width="144" height="144" />
        <div>
          <p className="td-kicker">TMflash for Mac</p>
          <h2 id="td-app-title">Plug in. Set up.<br />Ready to sense.</h2>
          <p>Flash one board or a whole batch, choose its network and frame rate, and check every device before it leaves your desk.</p>
        </div>
      </div>
      <div className="td-get">
        <span className="td-version">{release ? `Version ${release.version}` : 'Portable Mac app'}</span>
        <p className="td-platform">Intel + Apple Silicon<br />macOS {release?.minimumMacOS ?? '14'} or later</p>
        {release ? <a className="td-download" href={tmflashDownloadPath(release)} download={release.filename}>
          <DownloadSimple />Download for macOS<ArrowRight />
        </a> : <button className="td-download" disabled><DownloadSimple />{checking ? 'Preparing latest build…' : 'Download unavailable'}</button>}
        <p className="td-file">{release ? `.dmg installer · ${fileSize} · universal build` : 'One app. Everything you need inside.'}</p>
        <p className="td-update" role="status">{release?.stale ? 'GitHub is temporarily unavailable. This is the last verified build.'
          : release ? 'Latest published build · updates automatically' : checking ? 'Checking the TMflash release on GitHub…' : 'Download unavailable.'}</p>
        <button className="td-check" disabled={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check for updates'}</button>
      </div>
    </section>
    {error && <p className="td-message" role="alert">{error}</p>}

    <div className="td-features" aria-label="Included with TMflash">
      <div><span className="td-feature-mark" aria-hidden="true">01</span><h3>Everything included</h3><p>Firmware and native flashing tools are built in. No Python, PlatformIO or source folder to install.</p></div>
      <div><span className="td-feature-mark" aria-hidden="true">02</span><h3>One board or a batch</h3><p>Guided USB setup, Wi-Fi and hotspot selection, and 1, 2 or 4 fps. Each board gets its own device ID.</p></div>
      <div><span className="td-feature-mark" aria-hidden="true">03</span><h3>Works offline</h3><p>Write the included firmware anywhere. Go online when you’re ready to sign in and adopt a device.</p></div>
    </div>

    <section className="td-install" aria-labelledby="td-install-title">
      <div className="td-section-heading"><p className="td-kicker">From download to first board</p><h2 id="td-install-title">Install in three steps.</h2></div>
      <ol className="td-install-steps">
        <li><span aria-hidden="true">1</span><div><h3>Open the DMG</h3><p>Download the disk image, then double-click it in your Downloads folder.</p></div></li>
        <li><span aria-hidden="true">2</span><div><h3>Drag into Applications</h3><p>Drag TMflash onto the Applications shortcut in the installer. Eject the disk image afterwards.</p></div></li>
        <li><span aria-hidden="true">3</span><div><h3>Open TMflash and connect</h3><p>Launch the app from Applications, plug a Heltec V3 into USB, and follow the guided setup.</p></div></li>
      </ol>
      {release && !release.notarized && <div className="td-opening">
        <h3>If macOS asks about the developer</h3>
        <p>This build is not Apple-notarized. If you trust this TMflash release, try opening it once, then go to <b>System Settings → Privacy &amp; Security → Open Anyway</b>.</p>
        <a href="https://support.apple.com/en-us/102445" target="_blank" rel="noreferrer">Apple’s installation instructions <ArrowRight /></a>
      </div>}
    </section>

    <section className="td-release" aria-label="About this download">
      <div><p className="td-kicker">Always from the source</p><h2>The latest build, ready here.</h2>
        <p>The portal checks TMflash’s published GitHub builds automatically, verifies the file, and hosts the installer here. This page checks again every minute.</p>
        {release && <p className="td-build">Includes {release.firmware} · built {new Date(release.builtAt).toLocaleDateString()} · commit <code>{release.commit.slice(0, 7)}</code></p>}
        <a href={`https://github.com/${TMFLASH_REPOSITORY}/releases${release ? `/tag/${release.tag}` : ''}`} target="_blank" rel="noreferrer">View the GitHub release <ArrowRight /></a>
      </div>
      {release && <details className="td-integrity"><summary>Download checksum</summary><p>The installer’s SHA-256 matches the published release.</p><code>{release.sha256}</code></details>}
    </section>
    <p className="td-web-link">Prefer to flash from your browser? <a href="/flash" onClick={event => { event.preventDefault(); navigate('/flash'); }}>Open TMflash web <ArrowRight /></a></p>
  </main>;
}
