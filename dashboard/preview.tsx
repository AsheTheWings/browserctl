import { LoaderCircle, Maximize, Monitor, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiPath, errorMessage, segment, socketBase, type State } from './api.ts';
import { Button } from './ui/button.tsx';

export interface Preview {
  id: string;
  title: string;
  view: 'vnc' | 'window' | 'screencast' | 'recording';
  sessionId?: string;
  description?: string;
  fullscreen?: boolean;
  onFinished?: () => void;
}

const LIVE_EDGE_LAG_SECONDS = 1.5;
const LIVE_EDGE_TARGET_SECONDS = 0.3;

export function isPreviewEnded(preview: Preview, state: State | undefined): boolean {
  if (!state || preview.view === 'recording') return false;
  const session = state.sessions.find((entry) => entry.id === preview.id);
  if (preview.view === 'vnc') return !session || (session.state !== 'ready' && session.state !== 'saving');
  if (preview.view === 'window') return !session || session.state !== 'ready';
  return (!session || session.state !== 'ready') && !state.watched.some((entry) => entry.id === preview.id);
}

function Stream({ id, focused = false, ended = false }: { id: string; focused?: boolean; ended?: boolean }) {
  const image = useRef<HTMLImageElement>(null);
  const [frames, setFrames] = useState<'waiting' | 'live' | 'closed'>(() => (ended ? 'closed' : 'waiting'));
  useEffect(() => {
    if (ended) {
      setFrames('closed');
      return;
    }
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
  }, [id, focused, ended]);
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

function Vnc({ id, ended = false }: { id: string; ended?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>(() => (ended ? 'disconnected' : 'connecting'));
  useLayoutEffect(() => {
    host.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (ended) {
      setStatus('disconnected');
      return;
    }
    let active = true;
    let connection: { disconnect(): void; focus(options?: FocusOptions): void } | undefined;
    const url = '/dashboard/novnc/core/rfb.js';
    void import(/* @vite-ignore */ url).then(({ default: RFB }) => {
      if (!active || !host.current) return;
      const view = new RFB(host.current, `${socketBase}/vnc/${segment(id)}`);
      view.scaleViewport = true;
      view.qualityLevel = 9;
      view.focus({ preventScroll: true });
      view.addEventListener('connect', () => {
        if (!active) return;
        setStatus('connected');
        view.focus({ preventScroll: true });
        requestAnimationFrame(() => {
          if (active) view.focus({ preventScroll: true });
        });
      });
      view.addEventListener('disconnect', () => { if (active) setStatus('disconnected'); });
      connection = view;
    }).catch(() => { if (active) setStatus('disconnected'); });
    return () => { active = false; connection?.disconnect(); };
  }, [id, ended]);
  return (
    <div className="relative viewer-vnc-stage">
      <div ref={host} tabIndex={-1} className="viewer-vnc outline-none" />
      {status !== 'connected' && (
        <div role="status" className="absolute inset-0 grid place-items-center bg-card text-sm text-muted-foreground">
          {status === 'connecting' ? 'Connecting to browser window…' : 'Browser window disconnected.'}
        </div>
      )}
    </div>
  );
}

function WindowVideo({ id, ended = false }: { id: string; ended?: boolean }) {
  const player = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>(() => (ended ? 'disconnected' : 'connecting'));
  useEffect(() => {
    const video = player.current;
    if (!video) return;
    if (ended) {
      video.pause();
      video.removeAttribute('src');
      video.load();
      setStatus('disconnected');
      return;
    }
    const catchUp = () => {
      if (video.seeking || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.buffered.length === 0) return;
      const last = video.buffered.length - 1;
      const edge = video.buffered.end(last);
      if (edge - video.currentTime > LIVE_EDGE_LAG_SECONDS) {
        video.currentTime = Math.max(video.buffered.start(last), edge - LIVE_EDGE_TARGET_SECONDS);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      catchUp();
      if (video.paused) void video.play().catch(() => undefined);
    };
    video.addEventListener('timeupdate', catchUp);
    document.addEventListener('visibilitychange', onVisibilityChange);
    video.src = `${apiPath}/sessions/${segment(id)}/window`;
    return () => {
      video.removeEventListener('timeupdate', catchUp);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }, [id, ended]);
  return (
    <div className="relative viewer-window-stage">
      <video ref={player} aria-label="Live browser window" className="viewer-window" autoPlay muted playsInline
        onPlaying={() => { if (!ended) setStatus('connected'); }} onError={() => setStatus('disconnected')} onEnded={() => setStatus('disconnected')} />
      {status !== 'connected' && (
        <div role="status" className="absolute inset-0 flex items-center justify-center gap-2 bg-card text-sm text-muted-foreground">
          {status === 'connecting' && <LoaderCircle size={16} className="motion-safe:animate-spin" aria-hidden />}
          {status === 'connecting' ? 'Starting live video…' : 'Browser window disconnected.'}
        </div>
      )}
    </div>
  );
}

export function Viewer({ preview, ended = false, close, change }: {
  preview: Preview;
  ended?: boolean;
  close: () => void;
  change: (path: string) => Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [busyAction, setBusyAction] = useState<'save' | 'discard'>();
  const busy = busyAction !== undefined;
  const [actionError, setActionError] = useState('');
  const [fullscreen, setFullscreen] = useState(Boolean(preview.fullscreen));
  const [copyStatus, setCopyStatus] = useState('');
  const { sessionId } = preview;
  const details = [
    sessionId && preview.title !== sessionId ? preview.title : undefined,
    preview.description,
  ].filter(Boolean).join(' · ');

  useLayoutEffect(() => {
    const panel = dialog.current;
    panel?.showModal();
    if (preview.view === 'vnc') {
      panel?.querySelector<HTMLElement>('.viewer-vnc')?.focus({ preventScroll: true });
    }
    return () => panel?.close();
  }, [preview.view]);

  useLayoutEffect(() => {
    const target = surface.current;
    if (!fullscreen || !target) return;
    if (!document.fullscreenEnabled) {
      setFullscreen(false);
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
      if (!disposed) setFullscreen(false);
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
    setBusyAction(action);
    setActionError('');
    try {
      await change(`/sessions/${segment(preview.id)}/${action}`);
      preview.onFinished?.();
      close();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <dialog ref={dialog} onClose={close} aria-labelledby="preview-title"
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      className={preview.view === 'window' || preview.view === 'vnc' ? 'viewer viewer-window-dialog' : 'viewer'}>
      <div ref={surface} className="viewer-surface">
        <h2 id="preview-title" className="sr-only">{preview.title}</h2>
        {!fullscreen && <div className="viewer-header flex items-center justify-between gap-2 border-b px-2 sm:px-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {sessionId ? (
              <button type="button" className="min-w-0 shrink-0 max-w-full truncate rounded-sm text-left text-xs font-medium hover:underline"
                aria-label={`Copy session ID ${sessionId}`} title="Copy session ID"
                onClick={() => void copyId(sessionId)}>{sessionId}</button>
            ) : <span className="min-w-0 truncate text-xs font-medium">{preview.title}</span>}
            {details && <span className="min-w-0 truncate text-xs text-muted-foreground" title={details}>{details}</span>}
            {copyStatus && <span role="status" className="shrink-0 text-xs text-muted-foreground">{copyStatus}</span>}
          </div>
          <div className="ml-auto flex items-center gap-1">
            {preview.view === 'vnc' && <>
              <Button size="xs" aria-label="Save as new revision" title="Save as new revision" disabled={busy || ended} onClick={() => void finish('save')}>{busyAction === 'save' ? 'Saving…' : 'Save'}</Button>
              <Button size="xs" variant="outline" disabled={busy || ended} onClick={() => void finish('discard')}>{busyAction === 'discard' ? 'Discarding…' : 'Discard'}</Button>
            </>}
            {preview.view !== 'recording' && (
              <Button variant="ghost" size="icon-xs" disabled={busy} aria-label="Full screen" title="Full screen" onClick={() => setFullscreen(true)}>
                <Maximize aria-hidden />
              </Button>
            )}
            <Button variant="ghost" size="icon-xs" aria-label="Close viewer" onClick={close}><X aria-hidden /></Button>
          </div>
        </div>}
        <div className="viewer-content relative overflow-auto">
          {preview.view === 'recording' && (
            <div className="recording-stage">
              <video aria-label="Session recording" src={`${apiPath}/recordings/${segment(preview.id)}/video`} controls autoPlay playsInline />
            </div>
          )}
          {preview.view === 'screencast' && <Stream id={preview.id} focused ended={ended} />}
          {preview.view === 'vnc' && <Vnc id={preview.id} ended={ended} />}
          {preview.view === 'window' && <WindowVideo id={preview.id} ended={ended} />}
          {!fullscreen && actionError && <p role="alert" className="pointer-events-none absolute inset-x-2 bottom-2 mx-auto w-fit max-w-[calc(100%-1rem)] rounded-md border border-destructive/30 bg-card px-3 py-2 text-xs text-destructive shadow-sm">{actionError}</p>}
        </div>
      </div>
    </dialog>
  );
}
