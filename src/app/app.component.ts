import { Component, ElementRef, ViewChild, OnDestroy, OnInit, Input } from '@angular/core';
import { NgIf, DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { from, of, Observable, defer, timer, throwError, forkJoin } from 'rxjs';
import { switchMap, tap, catchError, concatMap, map, filter, take, finalize } from 'rxjs/operators';

// ===== Tipos globais para proofs/score =====
type OrientationSample = { alpha: number|null; beta: number|null; gamma: number|null } | null;
interface MobileContextProofs {
  cameraActive: boolean;
  cameraFacingMode?: string;
  cameraResolution?: { width?: number; height?: number };

  orientationOk: boolean;
  orientationSample?: OrientationSample;

  touchOk: boolean;
  coarsePointer: boolean;

  geoOk: boolean;
  geoAccuracy?: number;

  camerasCount?: number;
  vibrateSupport: boolean;
  screenOrientation?: string | undefined;
  connectionType?: string | undefined;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgIf, DatePipe, DecimalPipe, HttpClientModule],
  template: `
    <div class="cam-wrapper" (dragover)="$event.preventDefault()" (drop)="$event.preventDefault()" (paste)="$event.preventDefault()">
      <div *ngIf="!streamAtivo" class="start">
        <button (click)="iniciarCamera().subscribe()" [disabled]="scoreOk !== true">Abrir câmera</button>
        <button (click)="avaliarMobile()">Testar score de dispositivo</button>
      </div>

      <div class="score-panel">
        <h3>Verificação de dispositivo</h3>
        <div class="score-row">
          <div class="score-box" [class.ok]="scoreOk === true" [class.bad]="scoreOk === false">
            <div class="score-value">{{ score !== undefined ? (score | number:'1.1-1') : '--' }}</div>
            <div class="score-label">Score</div>
          </div>
          <div class="score-status">
            <span *ngIf="scoreOk === true">Aprovado como dispositivo móvel ✅</span>
            <span *ngIf="scoreOk === false">Reprovado (não aparenta ser um dispositivo móvel) ❌</span>
            <span *ngIf="scoreOk === undefined">Clique em "Testar score de dispositivo" para avaliar.</span>
          </div>
        </div>

        <details class="score-explain">
          <summary>Como o score é calculado?</summary>
          <ul>
            <li><b>+2</b> câmera ativa com traseira (<code>facingMode=environment</code>) ou orientação retrato (altura ≥ largura)</li>
            <li><b>+1</b> sensores de orientação entregando valores (alpha/beta/gamma)</li>
            <li><b>+1</b> toque habilitado <i>e</i> ponteiro "coarse"</li>
            <li><b>+1</b> geolocalização de alta precisão (&lt; 70m)</li>
            <li><b>+1</b> duas ou mais câmeras detectadas</li>
            <li><b>+0.5</b> suporte a vibração</li>
            <li><b>+0.5</b> orientação de tela em portrait</li>
          </ul>
          <p><b>Aprovação:</b> score ≥ 4.</p>
        </details>

        <div class="proofs" *ngIf="proofs">
          <h4>Provas coletadas</h4>
          <ul>
            <li>Câmera: ativa={{ proofs.cameraActive }} | facing={{ proofs.cameraFacingMode || '-' }} | res={{ proofs.cameraResolution?.width || '?' }}x{{ proofs.cameraResolution?.height || '?' }}</li>
            <li>Orientação: ok={{ proofs.orientationOk }} | amostra={{ proofs.orientationSample ? 'sim' : 'não' }}</li>
            <li>Toque/Ponteiro: touch={{ proofs.touchOk }} | coarse={{ proofs.coarsePointer }}</li>
            <li>Geo: ok={{ proofs.geoOk }} | accuracy={{ proofs.geoAccuracy !== undefined ? (proofs.geoAccuracy | number:'1.0-0') + 'm' : '-' }}</li>
            <li>Câmeras detectadas: {{ proofs.camerasCount ?? '-' }}</li>
            <li>Extras: vibrate={{ proofs.vibrateSupport }} | screen={{ proofs.screenOrientation || '-' }} | conn={{ proofs.connectionType || '-' }}</li>
          </ul>
        </div>
      </div>

      <div *ngIf="streamAtivo" class="cam-area">
        <video #video autoplay playsinline muted></video>

        <div class="actions">
          <button (click)="capturar()" [disabled]="capturando">Tirar foto</button>
          <button (click)="fecharCamera()">Fechar</button>
        </div>
        <div class="meta">
          <span>{{ now | date:'dd/MM/yyyy HH:mm' }}</span>
          <span *ngIf="coords">GPS: {{coords.latitude | number:'1.5-5'}}, {{coords.longitude | number:'1.5-5'}}</span>
          <span>Token: {{token}}</span>
        </div>
      </div>

      <img *ngIf="previewUrl" [src]="previewUrl" class="preview" alt="Prévia da foto" />
      <canvas #canvas hidden></canvas>
    </div>
  `,
  styles: [`
    .cam-wrapper { display:flex; flex-direction:column; gap:12px; }
    video { width:100%; max-height:60vh; background:#000; border-radius:12px; }
    .actions { display:flex; gap:8px; }
    .meta { font-size:12px; opacity:.8; display:flex; flex-wrap:wrap; gap:8px; }
    .preview { width:100%; max-width:600px; border:1px solid #ddd; border-radius:12px; }
    .hint { font-size:12px; opacity:.8; }
    .score-panel { border:1px solid #e5e5e5; border-radius:12px; padding:12px; margin-bottom:12px; }
    .score-row { display:flex; align-items:center; gap:16px; }
    .score-box { width:96px; height:96px; border-radius:12px; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#fafafa; border:1px solid #ddd; }
    .score-box.ok { border-color:#16a34a; background:#f0fdf4; }
    .score-box.bad { border-color:#dc2626; background:#fef2f2; }
    .score-value { font-size:28px; font-weight:700; }
    .score-label { font-size:12px; opacity:.7; }
    .score-status { font-size:14px; }
    .score-explain { margin-top:8px; }
    .proofs ul { margin: 8px 0 0 16px; }
  `]
})
export class AppComponent implements OnDestroy, OnInit {
  @Input() placa?: string; // opcional: placa na marca d’água
  @ViewChild('video', { static: false }) videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;

  stream: MediaStream | null = null;
  streamAtivo = false;
  capturando = false;
  previewUrl?: string;

  now = new Date();
  token = Math.random().toString(36).slice(2, 8).toUpperCase();
  coords?: GeolocationCoordinates;
  // Estado do score em tela
  score: number | undefined;
  scoreOk: boolean | undefined;
  proofs: MobileContextProofs | undefined;


  constructor(private http: HttpClient) {}

  ngOnInit() {
    // Calcula score assim que a página carrega
    this.avaliarMobile();
  }

  ngOnDestroy() { this.fecharCamera(); }

  // =====================
  // Fluxo público
  // =====================

  iniciarCamera(): Observable<void> {
    if (!this.preChecksOk()) return of(void 0);
    return this.calcularMobileScore$().pipe(
      tap(({ score, ok, proofs }) => { this.score = score; this.scoreOk = ok; this.proofs = proofs; }),
      switchMap(({ ok }) => ok ? this.verificarCamerasDisponiveis$() : of(false)),
      switchMap(tem => tem ? this.obterStreamComFallbacks$() : of(null)),
      switchMap(stream => stream ? this.exibirStreamNoVideo(stream) : of(void 0)),
      tap(() => this.iniciarGeolocalizacao())
    );
  }

  fecharCamera() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.streamAtivo = false;
  }

  capturar() {
    if (!this.streamAtivo) return;
    this.capturando = true;
    const video = this.videoRef.nativeElement;
    video.play().catch(() => {});

    this.criarBlobDaImagemDoVideo$(video, 1920, 0.9).subscribe(blob => {
      if (!blob) { this.capturando = false; return; }
      this.previewUrl = URL.createObjectURL(blob);
      this.enviarFoto(blob);
      this.capturando = false;
    });
  }

  avaliarMobile() {
    this.calcularMobileScore$().subscribe(({ score, ok, proofs }) => {
      this.score = score;
      this.scoreOk = ok;
      this.proofs = proofs;
      console.log('Mobile score:', score, proofs);
    });
  }

  // =====================
  // 1) Pré-checagens & diagnósticos
  // =====================

  private preChecksOk(): boolean {
    if (!window.isSecureContext) {
      alert('Precisa de HTTPS (ou localhost). Use a URL do trycloudflare/ngrok.');
      return false;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      alert('getUserMedia indisponível neste contexto. Abra no Chrome/Safari com HTTPS.');
      return false;
    }
    return true;
  }

  private verificarCamerasDisponiveis$(): Observable<boolean> {
    return from(navigator.mediaDevices.enumerateDevices()).pipe(
      map(devs => devs.filter(d => d.kind === 'videoinput')),
      tap(cams => console.log('Dispositivos de vídeo detectados:', cams)),
      map(cams => {
        if (!cams.length) {
          alert('Nenhuma câmera foi encontrada pelo navegador.\n\nVerifique: \n• Permissão de Câmera no navegador/sistema \n• Feche apps/abas que estejam usando a câmera');
          return false;
        }
        return true;
      }),
      catchError(e => {
        console.warn('enumerateDevices falhou (ignorável):', e);
        return of(true);
      })
    );
  }

  // =====================
  // Sinais individuais (JS puro)
  // =====================

  private getActiveCameraSettings(): { active: boolean; facingMode?: string; width?: number; height?: number } {
    const track = this.stream?.getVideoTracks?.()[0];
    const set = track?.getSettings?.();
    return {
      active: !!track,
      facingMode: (set as any)?.facingMode,
      width: set?.width,
      height: set?.height,
    };
  }

  private touchAndPointerProof() {
    const touchOk = (navigator.maxTouchPoints || 0) > 0;
    const coarsePointer = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)').matches : false;
    return { touchOk, coarsePointer };
  }

  private vibrateSupportProof() {
    return 'vibrate' in navigator;
  }

  private screenOrientationType() {
    return (window.screen?.orientation as any)?.type as (string | undefined);
  }

  private connectionType() {
    // Pode não existir em todos os navegadores
    // @ts-ignore
    return navigator.connection?.effectiveType as (string | undefined);
  }

  private requestDeviceOrientationPermission$(): Observable<boolean> {
    // iOS precisa de permissão via gesto; outros ignoram
    // @ts-ignore
    const DOE = (window as any).DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      return from(DOE.requestPermission() as Promise<string>).pipe(
        map(res => res === 'granted'),
        catchError(() => of(false))
      );
    }
    // Em navegadores não-iOS, considerar ok tentar sem permissão explícita
    return of(true);
  }

  private listenDeviceOrientationOnce$(): Observable<OrientationSample> {
    return new Observable<OrientationSample>((sub) => {
      const onEvt = (e: DeviceOrientationEvent) => {
        sub.next({ alpha: e.alpha, beta: e.beta, gamma: e.gamma });
        sub.complete();
      };
      const timeout = setTimeout(() => { sub.next(null); sub.complete(); }, 1200);
      window.addEventListener('deviceorientation', onEvt, { once: true });
      return () => { clearTimeout(timeout); window.removeEventListener('deviceorientation', onEvt as any); };
    });
  }

  private getHighAccuracyPosition$(): Observable<{ ok: boolean; accuracy?: number }> {
    if (!('geolocation' in navigator)) return of({ ok: false });
    return new Observable<{ ok: boolean; accuracy?: number }>((sub) => {
      const opts: PositionOptions = { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 };
      const onOk = (pos: GeolocationPosition) => { sub.next({ ok: true, accuracy: pos.coords.accuracy }); sub.complete(); };
      const onErr = () => { sub.next({ ok: false }); sub.complete(); };
      navigator.geolocation.getCurrentPosition(onOk, onErr, opts);
    });
  }

  private enumerateCameras$(): Observable<number> {
    if (!navigator.mediaDevices?.enumerateDevices) return of(0);
    return from(navigator.mediaDevices.enumerateDevices()).pipe(
      map(devs => devs.filter(d => d.kind === 'videoinput').length),
      catchError(() => of(0))
    );
  }

  // =====================
  // 2) Aquisição de stream (com fallbacks)
  // =====================

  private getTentativasConstraints(): MediaStreamConstraints[] {
    return [
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: { facingMode: { exact: 'environment' } }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false },
      { video: true, audio: false }
    ];
  }

  private obterStreamComFallbacks$(): Observable<MediaStream | null> {
    const tries = this.getTentativasConstraints();

    const tryIndex = (i: number): Observable<MediaStream> => from(navigator.mediaDevices.getUserMedia(tries[i])).pipe(
      tap(() => console.log('getUserMedia OK com', tries[i])),
      catchError(err => {
        console.warn('Falhou com constraints', tries[i], err);
        return i + 1 < tries.length ? tryIndex(i + 1) : throwError(() => err);
      })
    );

    return tryIndex(0).pipe(
      // Se não veio traseira, tenta escolher explicitamente por deviceId da traseira
      switchMap((stream) => {
        const facing = stream.getVideoTracks?.()[0]?.getSettings?.()?.facingMode as (string | undefined);
        if (facing === 'environment') return of(stream);
        return this.selecionarDeviceIdTraseira$().pipe(
          switchMap((deviceId) => {
            if (!deviceId) return of(stream);
            // fecha o stream anterior antes de trocar
            try { stream.getTracks().forEach(t => t.stop()); } catch {}
            const constraints: MediaStreamConstraints = { video: { deviceId: { exact: deviceId } as any }, audio: false };
            return from(navigator.mediaDevices.getUserMedia(constraints)).pipe(
              tap(() => console.log('Reabriu com deviceId traseiro')),
              catchError(err => {
                console.warn('Falhou reabrir com deviceId traseiro, mantendo stream anterior', err);
                return of(stream);
              })
            );
          })
        );
      }),
      catchError(err => { this.tratarErroGetUserMedia(err); return of(null); })
    );
  }

  private selecionarDeviceIdTraseira$(): Observable<string | null> {
    if (!navigator.mediaDevices?.enumerateDevices) return of(null);
    return from(navigator.mediaDevices.enumerateDevices()).pipe(
      map(devs => devs.filter(d => d.kind === 'videoinput')),
      map(cams => {
        // Tenta achar por label/back/rear/traseira/environment
        const re = /(back|rear|traseira|environment)/i;
        const encontrada = cams.find(c => re.test(c.label || ''));
        return encontrada?.deviceId || null;
      }),
      catchError(() => of(null))
    );
  }

  private tratarErroGetUserMedia(e: any) {
    console.error('Erro ao acessar câmera:', e);
    const name: string = e?.name || '';
    const msg: string = e?.message || '';

    if (name === 'NotAllowedError' || name === 'SecurityError') {
      alert('Acesso à câmera bloqueado para este domínio. No cadeado da URL/configurações do site, defina Câmera = Permitir e recarregue.');
      return;
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      alert('Câmera não encontrada ou restrições muito rígidas. Tente novamente após liberar permissões e fechar outros apps.');
      return;
    }
    if (name === 'NotReadableError') {
      alert('A câmera está em uso por outro app/aba. Feche o que estiver usando a câmera e tente novamente.');
      return;
    }

    alert('Não foi possível acessar a câmera. Motivo: ' + (name || msg || 'TypeError') +
      '\n\nVerifique:\n• HTTPS válido (trycloudflare/ngrok)\n• Permissão de Câmera para este site\n• Permissão do sistema (Privacy > Camera)\n• Outros apps/abas usando a câmera');
  }

  // =====================
  // Score agregando os sinais
  // =====================
  private calcularMobileScore$(): Observable<{ score: number; ok: boolean; proofs: MobileContextProofs }> {
    const cam = this.getActiveCameraSettings();

    // Fluxo de orientação: pedir permissão (se necessário) e ouvir 1 evento
    const orientation$ = this.requestDeviceOrientationPermission$().pipe(
      switchMap(ok => ok ? this.listenDeviceOrientationOnce$() : of(null)),
      map(sample => ({ ok: !!(sample && (sample.alpha !== null || sample.beta !== null || sample.gamma !== null)), sample }))
    );

    const geo$ = this.getHighAccuracyPosition$();
    const camsCount$ = this.enumerateCameras$();
    const touch = this.touchAndPointerProof();
    const vibrate = this.vibrateSupportProof();
    const screenOri = this.screenOrientationType();
    const conn = this.connectionType();

    return forkJoin({ orientation: orientation$, geo: geo$, camsCount: camsCount$ }).pipe(
      map(({ orientation, geo, camsCount }) => {
        const proofs: MobileContextProofs = {
          cameraActive: cam.active,
          cameraFacingMode: cam.facingMode,
          cameraResolution: { width: cam.width, height: cam.height },
          orientationOk: orientation.ok,
          orientationSample: orientation.sample,
          touchOk: touch.touchOk,
          coarsePointer: touch.coarsePointer,
          geoOk: geo.ok,
          geoAccuracy: geo.accuracy,
          camerasCount: camsCount,
          vibrateSupport: vibrate,
          screenOrientation: screenOri,
          connectionType: conn
        };

        // Pontuação (ajuste conforme política)
        let score = 0;
        if (proofs.cameraActive && (proofs.cameraFacingMode === 'environment' || (proofs.cameraResolution?.height || 0) >= (proofs.cameraResolution?.width || 0))) score += 2;
        if (proofs.orientationOk) score += 1;
        if (proofs.touchOk && proofs.coarsePointer) score += 1;
        if (proofs.geoOk && (proofs.geoAccuracy ?? 999) < 70) score += 1; //  <70m
        if ((proofs.camerasCount ?? 0) >= 2) score += 1;
        if (proofs.vibrateSupport) score += 0.5;
        if ((proofs.screenOrientation || '').includes('portrait')) score += 0.5;

        const ok = score >= 4; // corte padrão
        return { score, ok, proofs };
      })
    );
  }

  // =====================
  // 3) Exibição + geolocalização
  // =====================

  exibirStreamNoVideo(stream: MediaStream): Observable<void> {
    this.stream = stream;
    this.streamAtivo = true;
    return timer(0).pipe(
      tap(() => {
        const videoEl = this.videoRef?.nativeElement;
        if (!videoEl) { console.warn('videoRef não disponível após streamAtivo=true'); return; }
        videoEl.srcObject = stream;
        this.now = new Date();
      }),
      map(() => void 0)
    );
  }

  private iniciarGeolocalizacao() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => this.coords = pos.coords,
      _ => {},
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }

  // =====================
  // 4) Captura + marca d’água + upload
  // =====================

  criarBlobDaImagemDoVideo$(video: HTMLVideoElement, maxWidth: number, quality: number): Observable<Blob | null> {
    const canvas = this.canvasRef.nativeElement;
    const vw = video.videoWidth || 0;
    const vh = video.videoHeight || 0;
    const scale = vw > maxWidth ? maxWidth / vw : 1;

    canvas.width = Math.floor(vw * scale);
    canvas.height = Math.floor(vh * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return of(null);

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    this.desenharMarcaDagua(ctx, canvas.width, canvas.height);

    return new Observable<Blob | null>((subscriber) => {
      canvas.toBlob((blob) => {
        subscriber.next(blob);
        subscriber.complete();
      }, 'image/jpeg', quality);
    });
  }

  private desenharMarcaDagua(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const pad = 16;
    const lines = [
      `LAUDO • ${this.formatDate(new Date())}`,
      this.placa ? `PLACA: ${this.placa}` : '',
      this.coords ? `GPS: ${this.coords.latitude?.toFixed(5)}, ${this.coords.longitude?.toFixed(5)}` : '',
      `TOKEN: ${this.token}`
    ].filter(Boolean);

    ctx.save();
    ctx.font = 'bold 24px sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const boxH = 28 * lines.length + 20;
    ctx.fillRect(0, h - boxH, w, boxH);

    ctx.fillStyle = '#fff';
    let y = h - 12;
    for (let i = lines.length - 1; i >= 0; i--) {
      ctx.fillText(lines[i], pad, y);
      y -= 28;
    }
    ctx.restore();
  }

  private enviarFoto(blob: Blob) {
    // Monte o FormData para upload
    const form = new FormData();
    form.append('arquivo', blob, `laudo-${Date.now()}.jpg`);
    form.append('token', this.token);
    if (this.coords) {
      form.append('lat', String(this.coords.latitude));
      form.append('lng', String(this.coords.longitude));
    }
    if (this.placa) form.append('placa', this.placa);

    this.http.post('/api/laudos/upload-foto', form).subscribe({
      next: (res) => console.log('Upload concluído', res),
      error: (err) => console.error('Erro no upload', err)
    });
  }

  // =====================
  // Utilidades
  // =====================

  private formatDate(d: Date) {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}