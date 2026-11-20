import { LoaderCircle, Maximize, Monitor, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiPath, segment, socketBase } from './api.ts';
import { Button } from './ui/button.tsx';

export interface Preview {
  id: string;
  title: string;
  view: 'vnc' | 'window' | 'screencast' | 'recording';
  sessionId?: string;
  description?: string;
  fullscreen?: boolean;
}

function Stream({ id, focused = false }: { id: string; focused?: boolean }) {
  const image = useRef<HTMLImageElement>(null);
  const [frames, setFrames] = useState<'waiting' | 'live' | 'closed'>('waiting');
  useEffect(() => {
    const connection = new WebSocket(`${socketBase}/screencast/${segment(id)}?stream=${focused ? 'focused' : 'grid'}`);
    connection.binaryType = 'blob';
    let frame: string | undefined;
    let closed = false;
    let shown = false;
    connection.onmessage = ({ data }: MessageEvent<Blob>) => {
      if (!image.current || closed) return;
      if (frame) URL.revokeObjectURL(frame);
      frame = URL.createObjectURL(data);
      image.current.src = frame;
      if (!shown) {
        shown = true;
        setFrames('live');
      }
    };
    connection.onclose = () => { if (!closed) setFrames('closed'); };
    return () => {
      closed = true;
      connection.close();
      if (frame) URL.revokeObjectURL(frame);
    };
  }, [id, focused]);
  return (
    <div className={focused ? 'flex min-h-28 items-center justify-center' : 'tile-media relative'}>
      <img ref={image} alt={focused ? 'Live browser view' : ''} className={focused ? 'viewer-media' : ''} hidden={frames !== 'live'} />
      {frames !== 'live' && <span className="absolute text-xs text-muted-foreground inset-0 flex items-center justify-center pointer-events-none">{frames === 'waiting' ? 'Connecting…' : 'Stream ended'}</span>}
    </div>
  );
}

export function BrowserTile({ preview, description, open }: {
  preview: Preview;
  description: string;
  open: (fullscreen: boolean) => void;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border bg-card transition hover:border-ring focus-within:border-ring">
      <button type="button" onClick={() => open(false)} className="block w-full text-left">
        {preview.view === 'screencast' || preview.view === 'window' ? (
          <Stream id={preview.id} />
        ) : (
          <div className="tile-media flex items-center justify-center text-muted-foreground"><Monitor size={24} aria-hidden /></div>
        )}
        <span className="flex h-9 items-center gap-2 pl-3 pr-10">
          <span className="min-w-0 shrink-0 basis-auto max-w-[55%] truncate text-xs font-medium">{preview.title}</span>
          <span className="min-w-0 truncate text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
      <Button variant="ghost" size="icon-sm" className="absolute right-1 bottom-0.5"
        aria-label={`Open ${preview.title} fullscreen`} title="Full screen"
        onClick={() => open(true)}><Maximize aria-hidden /></Button>
    </div>
  );
}

function Vnc({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  useEffect(() => {
    let active = true;
    let connection: { disconnect(): void } | undefined;
    const url = '/dashboard/novnc/core/rfb.js';
    void import(/* @vite-ignore */ url).then(({ default: RFB }) => {
      if (!active || !host.current) return;
      const view = new RFB(host.current, `${socketBase}/vnc/${segment(id)}`);
      view.scaleViewport = true;
      view.qualityLevel = 9;
      view.addEventListener('connect', () => { if (active) setStatus('connected'); });
      view.addEventListener('disconnect', () => { if (active) setStatus('disconnected'); });
      connection = view;
    }).catch(() => { if (active) setStatus('disconnected'); });
    return () => { active = false; connection?.disconnect(); };
  }, [id]);
  return (
    <div className="relative viewer-vnc-stage">
      <div ref={host} className="viewer-vnc" />
      {status !== 'connected' && (
        <div role="status" className="absolute inset-0 grid place-items-center bg-card text-sm text-muted-foreground">
          {status === 'connecting' ? 'Connecting to browser window…' : 'Browser window disconnected.'}
        </div>
      )}
    </div>
  );
}

function WindowVideo({ id }: { id: string }) {
  const player = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  useEffect(() => {
    const video = player.current;
    if (!video) return;
    video.src = `${apiPath}/sessions/${segment(id)}/window`;
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [id]);
  return (
    <div className="relative viewer-window-stage">
      <video ref={player} aria-label="Live browser window" className="viewer-window" autoPlay muted playsInline
        onPlaying={() => setStatus('connected')} onError={() => setStatus('disconnected')} onEnded={() => setStatus('disconnected')} />
      {status !== 'connected' && (
        <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-card text-sm text-muted-foreground">
          {status === 'connecting' && <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden />}
          {status === 'connecting' ? 'Starting live video…' : 'Browser window disconnected.'}
        </div>
      )}
    </div>
  );
}

export function Viewer({ preview, close, change, error }: {
  preview: Preview;
  close: () => void;
  error: string;
  change: (path: string) => Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [fullscreen, setFullscreen] = useState(Boolean(preview.fullscreen));
  const [fullscreenFallback, setFullscreenFallback] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const showClose = !fullscreen || fullscreenFallback;
  const showHeader = showClose || preview.view === 'vnc';
  const { sessionId } = preview;
  const details = [
    sessionId && preview.title !== sessionId ? preview.title : undefined,
    preview.description,
  ].filter(Boolean).join(' · ');

  useLayoutEffect(() => {
    const panel = dialog.current;
    panel?.showModal();
    return () => panel?.close();
  }, []);

  useLayoutEffect(() => {
    const target = surface.current;
    if (!fullscreen || !target) return;
    if (!document.fullscreenEnabled) {
      setFullscreenFallback(true);
      return;
    }
    let entered = false;
    let disposed = false;
    const closeOnExit = () => {
      if (entered && document.fullscreenElement !== target) close();
    };
    document.addEventListener('fullscreenchange', closeOnExit);
    void target.requestFullscreen().then(() => {
      if (disposed) return;
      entered = true;
      closeOnExit();
    }, () => {
      if (!disposed) setFullscreenFallback(true);
    });
    return () => {
      disposed = true;
      document.removeEventListener('fullscreenchange', closeOnExit);
    };
  }, [fullscreen, close]);

  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(''), 2000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  async function copyId(id: string) {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(id);
      } else {
        const selection = document.createElement('textarea');
        selection.value = id;
        selection.readOnly = true;
        selection.tabIndex = -1;
        selection.className = 'sr-only';
        const focused = document.activeElement;
        dialog.current?.append(selection);
        try {
          selection.select();
          if (!document.execCommand('copy')) throw new Error('Copy refused');
        } finally {
          selection.remove();
          if (focused instanceof HTMLElement) focused.focus();
        }
      }
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Could not copy');
    }
  }

  async function finish(action: 'save' | 'discard') {
    setBusy(true);
    try {
      if (await change(`/sessions/${segment(preview.id)}/${action}`)) close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} onClose={close} aria-labelledby="preview-title" data-fullscreen={fullscreen || undefined}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      className={preview.view === 'window' ? 'viewer viewer-window-dialog' : preview.view === 'vnc' ? 'viewer viewer-full-window' : 'viewer'}>
      <div ref={surface} className="viewer-surface">
        <div className={showHeader
          ? `viewer-header flex flex-wrap items-center justify-between gap-2 border-b ${preview.view === 'recording' ? 'px-4 py-3 sm:px-6' : 'px-3 py-0.5'}`
          : 'sr-only'}>
          <div className={fullscreen ? 'sr-only' : 'flex min-w-0 flex-1 items-center gap-2'}>
            <h2 id="preview-title" className={sessionId ? 'sr-only' : 'min-w-0 truncate text-sm font-medium'}>{preview.title}</h2>
            {!fullscreen && sessionId && (
              <button type="button" className="min-w-0 truncate rounded-sm text-left text-sm font-medium hover:underline"
                aria-label={`Copy session ID ${sessionId}`} title="Copy session ID"
                onClick={() => void copyId(sessionId)}>{sessionId}</button>
            )}
            {!fullscreen && details && <span className="min-w-0 truncate text-xs text-muted-foreground" title={details}>{details}</span>}
            {!fullscreen && copyStatus && <span role="status" className="shrink-0 text-xs text-muted-foreground">{copyStatus}</span>}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {preview.view === 'vnc' && <>
              <Button size="sm" disabled={busy} onClick={() => void finish('save')}>Save as new revision</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void finish('discard')}>Discard</Button>
            </>}
            {!fullscreen && preview.view !== 'recording' && (
              <Button variant="ghost" size="icon-sm" aria-label="Full screen" title="Full screen" onClick={() => setFullscreen(true)}>
                <Maximize aria-hidden />
              </Button>
            )}
            {showClose && <Button variant="ghost" size="icon-sm" aria-label="Close viewer" onClick={close}><X aria-hidden /></Button>}
          </div>
        </div>
        {error && preview.view === 'vnc' && <p role="alert" className="viewer-error border-b px-4 py-2 text-destructive">{error}</p>}
        <div className="viewer-content relative overflow-auto">
          {preview.view === 'recording' && (
            <div className="recording-stage">
              <video aria-label="Session recording" src={`${apiPath}/recordings/${segment(preview.id)}/video`} controls autoPlay playsInline />
            </div>
          )}
          {preview.view === 'screencast' && <Stream id={preview.id} focused />}
          {preview.view === 'vnc' && <Vnc id={preview.id} />}
          {preview.view === 'window' && <WindowVideo id={preview.id} />}
        </div>
      </div>
    </dialog>
  );
}
