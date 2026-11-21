import { LoaderCircle, Maximize, Monitor, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react';
import { apiPath, errorMessage, segment, socketBase } from './api.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';

export interface Preview {
  id: string;
  title: string;
  view: 'vnc' | 'window' | 'screencast' | 'recording' | 'profile-edit';
  sessionId?: string;
  description?: string;
  fullscreen?: boolean;
  onFinished?: () => void;
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

function ProfileEditPage({ id, fullscreen, ready }: { id: string; fullscreen: boolean; ready: (value: boolean) => void }) {
  const image = useRef<HTMLImageElement>(null);
  const socket = useRef<WebSocket>(null);
  const [status, setStatus] = useState<'waiting' | 'live' | 'closed'>('waiting');
  const [connected, setConnected] = useState(false);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const connection = new WebSocket(`${socketBase}/profile-edit/${segment(id)}`);
    socket.current = connection;
    let imageUrl: string | undefined;
    let active = true;
    let received = false;
    connection.binaryType = 'blob';
    connection.onopen = () => { if (active) setConnected(true); };
    connection.onmessage = ({ data }: MessageEvent<Blob | string>) => {
      if (!active) return;
      if (typeof data === 'string') {
        setFailure('The browser could not apply that input.');
        return;
      }
      if (!image.current) return;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = URL.createObjectURL(data);
      image.current.src = imageUrl;
      if (!received) {
        received = true;
        setStatus('live');
        ready(true);
      }
    };
    connection.onclose = () => {
      if (active) {
        setConnected(false);
        setStatus('closed');
        ready(false);
      }
    };
    return () => {
      active = false;
      connection.close();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [id, ready]);
  function send(action: Record<string, unknown>) {
    if (socket.current?.readyState !== WebSocket.OPEN || socket.current.bufferedAmount > 8192) return;
    setFailure('');
    socket.current.send(JSON.stringify(action));
  }
  function point(event: MouseEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }
  return <div className="grid min-h-28 min-w-0 gap-2">
    {!fullscreen && <form className="flex flex-wrap gap-2 p-2" onSubmit={(event) => {
      event.preventDefault();
      const url = String(new FormData(event.currentTarget).get('url')).trim();
      send({ type: 'navigate', url: /^https?:\/\//i.test(url) ? url : `https://${url}` });
    }}>
      <Input name="url" type="text" inputMode="url" aria-label="Browser address" placeholder="Enter a website address" autoComplete="off"
        className="min-w-40 flex-1" maxLength={2048} required disabled={!connected} />
      <Button type="submit" size="sm" disabled={!connected}>Go</Button>
    </form>}
    {!fullscreen && status === 'live' && <form className="flex flex-wrap gap-2 px-2 sm:hidden" onSubmit={(event) => {
      event.preventDefault();
      const form = event.currentTarget;
      send({ type: 'text', text: String(new FormData(form).get('text')) });
      form.reset();
    }}>
      <Input name="text" type="text" aria-label="Type into remote field" placeholder="Type into selected field"
        autoComplete="off" className="min-w-40 flex-1" maxLength={4096} required />
      <Button type="submit" size="sm">Type</Button>
    </form>}
    {status !== 'live' && <p role="status" className="m-auto p-4 text-center text-sm text-muted-foreground">
      {status === 'waiting' ? 'Connecting to provider browser…' : 'Profile editor disconnected.'}
    </p>}
    <img ref={image} hidden={status !== 'live'} className="viewer-media cursor-default select-none" draggable={false}
      alt="Interactive provider browser page" tabIndex={status === 'live' ? 0 : -1}
      onClick={(event) => { event.currentTarget.focus(); send({ type: 'click', ...point(event) }); }}
      onWheel={(event) => send({ type: 'wheel', ...point(event), dx: event.deltaX, dy: event.deltaY })}
      onPaste={(event) => { event.preventDefault(); send({ type: 'text', text: event.clipboardData.getData('text') }); }}
      onKeyDown={(event) => {
        if (event.key === 'Tab' && event.shiftKey) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') return;
        event.preventDefault();
        const modifiers = Number(event.altKey) | Number(event.ctrlKey) << 1 | Number(event.metaKey) << 2 | Number(event.shiftKey) << 3;
        send({ type: 'key', key: event.key, code: event.code, modifiers, keyCode: event.keyCode });
      }} />
    {failure && <p role="alert" className="px-2 pb-1 text-xs text-destructive">{failure}</p>}
  </div>;
}

export function Viewer({ preview, close, change }: {
  preview: Preview;
  close: () => void;
  change: (path: string) => Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [fullscreen, setFullscreen] = useState(Boolean(preview.fullscreen));
  const [copyStatus, setCopyStatus] = useState('');
  const [editReady, setEditReady] = useState(false);
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
    setBusy(true);
    setActionError('');
    try {
      const path = preview.view === 'profile-edit' ? 'profile-edits' : 'sessions';
      await change(`/${path}/${segment(preview.id)}/${action}`);
      preview.onFinished?.();
      close();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusy(false);
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
            {(preview.view === 'vnc' || preview.view === 'profile-edit') && <>
              <Button size="xs" aria-label="Save as new revision" title="Save as new revision" disabled={busy || (preview.view === 'profile-edit' && !editReady)} onClick={() => void finish('save')}>Save</Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void finish('discard')}>Discard</Button>
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
          {preview.view === 'screencast' && <Stream id={preview.id} focused />}
          {preview.view === 'vnc' && <Vnc id={preview.id} />}
          {preview.view === 'profile-edit' && <ProfileEditPage id={preview.id} fullscreen={fullscreen} ready={setEditReady} />}
          {preview.view === 'window' && <WindowVideo id={preview.id} />}
          {!fullscreen && actionError && <p role="alert" className="pointer-events-none absolute inset-x-2 bottom-2 mx-auto w-fit max-w-[calc(100%-1rem)] rounded-md border border-destructive/30 bg-card px-3 py-2 text-xs text-destructive shadow-sm">{actionError}</p>}
        </div>
      </div>
    </dialog>
  );
}
