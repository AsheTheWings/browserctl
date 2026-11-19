import { CircleAlert, Maximize2, Monitor, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { apiPath, errorMessage, segment, socketBase } from './api.ts';
import { Button } from './ui/button.tsx';

export interface Preview {
  id: string;
  title: string;
  view: 'vnc' | 'screencast' | 'recording';
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

export function BrowserTile({ preview, description, open }: { preview: Preview; description: string; open: () => void }) {
  return (
    <button type="button" onClick={open} className="group overflow-hidden rounded-xl border bg-card text-left transition hover:border-ring">
      {preview.view === 'screencast' ? <Stream id={preview.id} /> : (
        <div className="tile-media flex items-center justify-center text-muted-foreground"><Monitor size={24} aria-hidden /></div>
      )}
      <span className="flex items-center justify-between gap-2 px-4 py-3">
        <span className="min-w-0">
          <span className="block truncate font-medium">{preview.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        </span>
        <Maximize2 size={14} className="shrink-0 text-muted-foreground" aria-hidden />
      </span>
    </button>
  );
}

function Vnc({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let connection: { disconnect(): void } | undefined;
    const url = '/dashboard/novnc/core/rfb.js';
    void import(/* @vite-ignore */ url).then(({ default: RFB }) => {
      if (!active || !host.current) return;
      const view = new RFB(host.current, `${socketBase}/vnc/${segment(id)}`);
      view.scaleViewport = true;
      connection = view;
    }).catch((failure: unknown) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; connection?.disconnect(); };
  }, [id]);
  return error ? <div role="alert" className="flex items-center gap-2 p-5 text-destructive"><CircleAlert size={16} />{error}</div> : <div ref={host} className="viewer-vnc" />;
}

export function Viewer({ preview, close, change, error }: {
  preview: Preview;
  close: () => void;
  error: string;
  change: (path: string) => Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);

  async function finish(action: 'save' | 'discard') {
    setBusy(true);
    try {
      if (await change(`/sessions/${segment(preview.id)}/${action}`)) close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} onClose={close} aria-labelledby="preview-title" className="viewer">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-6">
        <h2 id="preview-title" className="min-w-0 break-all font-medium">{preview.title}</h2>
        <div className="flex items-center gap-2">
          {preview.view === 'vnc' && <>
            <Button size="sm" disabled={busy} onClick={() => void finish('save')}>Save as new revision</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void finish('discard')}>Discard</Button>
          </>}
          <Button variant="ghost" size="icon-sm" aria-label="Close viewer" onClick={close}><X aria-hidden /></Button>
        </div>
      </div>
      {error && preview.view === 'vnc' && <p role="alert" className="border-b px-4 py-2 text-destructive">{error}</p>}
      <div className="relative overflow-auto">
        {preview.view === 'recording' && (
          <div className="recording-stage">
            <video aria-label="Session recording" src={`${apiPath}/recordings/${segment(preview.id)}/video`} controls autoPlay playsInline />
          </div>
        )}
        {preview.view === 'screencast' && <Stream id={preview.id} focused />}
        {preview.view === 'vnc' && <Vnc id={preview.id} />}
      </div>
    </dialog>
  );
}
