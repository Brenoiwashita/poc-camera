import { Component, ElementRef, ViewChild, OnDestroy, Input } from '@angular/core';
import { NgIf, DatePipe, DecimalPipe } from '@angular/common';
import { HttpClient, HttpClientModule } from '@angular/common/http';
import { from, of, Observable, defer, timer, throwError } from 'rxjs';
import { switchMap, tap, catchError, concatMap, map, filter, take, finalize } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NgIf, DatePipe, DecimalPipe, HttpClientModule],
  template: `
    <div class="cam-wrapper" (dragover)="$event.preventDefault()" (drop)="$event.preventDefault()" (paste)="$event.preventDefault()">
      <div *ngIf="!streamAtivo" class="start">
        <button (click)="iniciarCamera().subscribe()">Abrir câmera</button>
        <p class="hint">A câmera é obrigatória para o laudo (não aceitamos upload da galeria).</p>
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
  `]
})
export class AppComponent implements OnDestroy {
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

  constructor(private http: HttpClient) {}

  ngOnDestroy() { this.fecharCamera(); }

  // =====================
  // Fluxo público
  // =====================

  iniciarCamera(): Observable<number> {
    if (!this.preChecksOk()) return of();
    return this.verificarCamerasDisponiveis$().pipe(
      switchMap(tem => tem ? this.obterStreamComFallbacks$() : of(null)),
      switchMap(stream => stream ? this.exibirStreamNoVideo(stream) : of()),
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
  // 2) Aquisição de stream (com fallbacks)
  // =====================

  private getTentativasConstraints(): MediaStreamConstraints[] {
    return [
      { video: true, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }
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
      catchError(err => { this.tratarErroGetUserMedia(err); return of(null); })
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
  // 3) Exibição + geolocalização
  // =====================

  exibirStreamNoVideo(stream: MediaStream): Observable<number> {
    this.stream = stream;
    this.streamAtivo = true;
    return timer(0).pipe(
      tap(() => {
        const videoEl = this.videoRef?.nativeElement;
        if (!videoEl) { console.warn('videoRef não disponível após streamAtivo=true'); return; }
        videoEl.srcObject = stream;
        this.now = new Date();
      })
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