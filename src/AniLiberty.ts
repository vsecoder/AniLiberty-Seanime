/// <reference path="./anime-torrent-provider.d.ts" />
/// <reference path="./core.d.ts" />

class Provider {
  private api = "https://aniliberty.top/api/v1";

  private headers = {
    "accept": "application/json",
    "X-CSRF-TOKEN": "seanime"
  };

  getSettings(): AnimeProviderSettings {
    return {
      type: "main",
      canSmartSearch: false,
      smartSearchFilters: [],
      supportsAdult: true
    };
  }

  async search(opts: AnimeSearchOptions): Promise<AnimeTorrent[]> {
    const url =
      `${this.api}/app/search/releases` +
      `?query=${encodeURIComponent(opts.query)}` +
      `&include=id,name`;

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error("AniLiberty search failed");

    const releases = await res.json();
    const out: AnimeTorrent[] = [];

    for (const r of releases) {
      const torrents = await this.fetchTorrents(r.id, r);
      out.push(...torrents);
    }

    return out;
  }

  async getLatest(): Promise<AnimeTorrent[]> {
    return [];
  }

  async smartSearch(): Promise<AnimeTorrent[]> {
    return [];
  }

  async getTorrentMagnetLink(t: AnimeTorrent): Promise<string> {
    return t.magnetLink || "";
  }

  // -------------------------
  // Internal
  // -------------------------

  private async fetchTorrents(releaseId: number, release: any): Promise<AnimeTorrent[]> {
    const url =
      `${this.api}/anime/torrents/release/${releaseId}` +
      `?include=*&exclude=poster,description`;

    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return [];

    const data = await res.json();
    return data.map((t: any) => this.toAnimeTorrent(t, release));
  }

  private toAnimeTorrent(t: any, release: any): AnimeTorrent {
    const title =
      release?.name?.english ||
      release?.name?.main ||
      t.label;

    const resolution = t.quality?.description || "";
    const isBatch = this.isBatch(t.description);
    const episode = this.extractEpisode(t.description);

    return {
      name: `${title} [${resolution}]`,
      date: t.created_at || "",
      size: t.size || 0,
      formattedSize: this.bytesToHuman(t.size || 0),
      seeders: t.seeders ?? -1,
      leechers: t.leechers ?? -1,
      downloadCount: t.completed_times ?? 0,
      link: "",
      downloadUrl: "",
      magnetLink: t.magnet || "",
      infoHash: t.hash || "",
      resolution,
      releaseGroup: "AniLiberty",
      isBatch,
      episodeNumber: isBatch ? -1 : episode,
      isBestRelease: this.isBest(t),
      confirmed: true
    };
  }

  // -------------------------
  // Helpers
  // -------------------------

  private isBatch(desc: string): boolean {
    if (!desc) return false;
    return /\d+\s*[-~]\s*\d+|batch|complete|ova/i.test(desc);
  }

  private extractEpisode(desc: string): number {
    if (!desc) return -1;
    const match = desc.match(/\b(\d{1,3})\b/);
    return match ? parseInt(match[1], 10) : -1;
  }

  private isBest(t: any): boolean {
    return (
      t.quality?.description === "1080p" &&
      t.seeders > 50 &&
      t.codec?.value !== "xvid"
    );
  }

  private bytesToHuman(bytes: number): string {
    if (!bytes) return "";
    const k = 1024;
    const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
  }
}
