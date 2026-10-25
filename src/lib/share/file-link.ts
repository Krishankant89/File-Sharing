import { defaultIceServers } from "@/lib/multiplayer";
import type { Tunnel } from "@/lib/share/secure-pipe";

type Role = "host" | "guest";
type SignalKind = "offer" | "answer" | "ice";

interface SignalRow {
  id: number;
  from: string;
  kind: SignalKind;
  payload: unknown;
}

interface PollBody {
  peers: { id: string; name: string }[];
  signals: SignalRow[];
}

export class FileLink {
  private pc: RTCPeerConnection | null = null;
  private cursor = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private offered = false;
  private remoteSet = false;
  private pending: RTCIceCandidateInit[] = [];
  private inbox: Uint8Array[] = [];
  private messageHandler: ((bytes: Uint8Array) => void) | null = null;
  readonly tunnel: Tunnel;
  onOpen: (() => void) | null = null;
  candidateType: string | null = null;

  constructor(
    private readonly room: string,
    private readonly selfId: Role,
    private readonly lanOnly: boolean,
  ) {
    this.tunnel = {
      label: "Direct",
      send: async () => {
        throw new Error("Direct channel is not open yet.");
      },
      close: () => this.close(),
      setHandler: (handler) => {
        this.messageHandler = handler;
        for (const bytes of this.inbox.splice(0)) handler(bytes);
      },
    };
  }

  start() {
    if (this.selfId === "guest") this.ensurePc();
    this.schedule(0);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pc?.close();
    this.pc = null;
    void fetch("/api/rtc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "leave", room: this.room, peer: this.selfId }),
      keepalive: true,
    }).catch(() => {});
  }

  private other(): Role {
    return this.selfId === "host" ? "guest" : "host";
  }

  private schedule(delay: number) {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private ensurePc() {
    if (this.pc || this.closed) return;
    const pc = new RTCPeerConnection({
      iceServers: defaultIceServers(),
    });
    this.pc = pc;
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      void this.signal("ice", event.candidate.toJSON());
    };
    pc.ondatachannel = (event) => this.bind(event.channel);
  }

  private isPrivateAddress(ip?: string): boolean {
    if (!ip) return false;
    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") return true;
    if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip)) return true;
    if (ip.startsWith("fc00:") || ip.startsWith("fd00:")) return true;
    return false;
  }

  private bind(channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    this.tunnel.send = async (bytes) => {
      if (channel.readyState !== "open") throw new Error("The direct connection closed.");
      while (channel.bufferedAmount > 2_000_000) {
        if (channel.readyState !== "open") throw new Error("The direct connection closed.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const payload = new Uint8Array(bytes.byteLength);
      payload.set(bytes);
      channel.send(payload);
    };
    channel.onmessage = (event) => {
      const bytes = new Uint8Array(event.data as ArrayBuffer);
      if (this.messageHandler) this.messageHandler(bytes);
      else this.inbox.push(bytes);
    };
    channel.onopen = () => {
      void this.readCandidateType().then(() => this.onOpen?.());
    };
  }

  private async readCandidateType() {
    if (!this.pc) return;
    try {
      const stats = await this.pc.getStats();
      let pairId = "";
      for (const report of stats.values()) {
        const row = report as {
          type?: string;
          selectedCandidatePairId?: string;
          selected?: boolean;
          nominated?: boolean;
          state?: string;
          id?: string;
        };
        if (row.type === "transport" && row.selectedCandidatePairId) pairId = row.selectedCandidatePairId;
        if (row.type === "candidate-pair" && row.state === "succeeded" && (row.selected || row.nominated)) {
          pairId = row.id ?? pairId;
        }
      }
      const pair = pairId ? (stats.get(pairId) as { localCandidateId?: string; remoteCandidateId?: string } | undefined) : undefined;
      const local = pair?.localCandidateId
        ? (stats.get(pair.localCandidateId) as { candidateType?: string; address?: string; ip?: string } | undefined)
        : undefined;
      const remote = pair?.remoteCandidateId
        ? (stats.get(pair.remoteCandidateId) as { candidateType?: string; address?: string; ip?: string } | undefined)
        : undefined;

      this.candidateType = local?.candidateType ?? null;
      const localIp = local?.address || local?.ip;
      const remoteIp = remote?.address || remote?.ip;
      const isLocalHost = this.candidateType === "host" || (this.isPrivateAddress(localIp) && this.isPrivateAddress(remoteIp));

      this.tunnel.isLocal = isLocalHost;
      this.tunnel.label = isLocalHost
        ? "Direct · local network (up to 10 GB)"
        : "Direct · remote path (up to 10 GB)";
    } catch {
      this.tunnel.isLocal = false;
      this.tunnel.label = "Direct · WebRTC (up to 10 GB)";
    }
  }

  private async poll() {
    if (this.closed) return;
    try {
      const params = new URLSearchParams({
        room: this.room,
        peer: this.selfId,
        name: this.selfId,
        since: String(this.cursor),
      });
      const res = await fetch(`/api/rtc?${params}`);
      if (!res.ok || this.closed) throw new Error("poll");
      const body = (await res.json()) as PollBody;
      if (this.selfId === "host" && !this.offered && body.peers.some((peer) => peer.id === "guest")) {
        this.offered = true;
        try {
          await this.createOffer();
        } catch {
          this.offered = false;
        }
      }
      for (const signal of body.signals) {
        this.cursor = Math.max(this.cursor, signal.id);
        if (signal.from === this.other()) await this.onSignal(signal.kind, signal.payload);
      }
    } catch {
      // Keep polling. A dropped request should not end the room.
    }
    this.schedule(this.pc?.connectionState === "connected" ? 2000 : 350);
  }

  private async createOffer() {
    this.ensurePc();
    if (!this.pc) return;
    const channel = this.pc.createDataChannel("files", { ordered: true });
    this.bind(channel);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.signal("offer", this.pc.localDescription?.toJSON());
  }

  private async onSignal(kind: SignalKind, payload: unknown) {
    this.ensurePc();
    if (!this.pc || this.closed) return;
    if (kind === "offer" || kind === "answer") {
      await this.pc.setRemoteDescription(payload as RTCSessionDescriptionInit);
      this.remoteSet = true;
      await this.flush();
      if (kind === "offer") {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.signal("answer", this.pc.localDescription?.toJSON());
      }
      return;
    }
    const candidate = payload as RTCIceCandidateInit;
    if (!this.remoteSet) this.pending.push(candidate);
    else await this.pc.addIceCandidate(candidate);
  }

  private async flush() {
    if (!this.pc) return;
    while (this.pending.length) {
      const candidate = this.pending.shift()!;
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // A stale candidate should not kill the pair.
      }
    }
  }

  private async signal(kind: SignalKind, payload: unknown) {
    await fetch("/api/rtc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: "signal",
        room: this.room,
        from: this.selfId,
        to: this.other(),
        kind,
        payload,
      }),
    });
  }
}
